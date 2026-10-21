import {
  compareUnicodeCodePoints as compare,
  compositeKey,
} from "../unicodeCodePointOrder.js";
import { iterateUrlQueryParameters } from "../recordedTransportUrl.js";
import {
  allLines,
  decodedSegment,
  isParam,
  listsAll,
  pagesOnly,
  segmentsOf,
  type StateRecordFacts,
  type StateToolFacts,
  type StateView,
} from "./environmentStateRules.js";

/** A query as replay compares a call's: decoded values by name, in any order; undefined when it repeats a name with another value, which no call's arguments can carry. */
const queryKey = (query: string | undefined): string | undefined => {
  const values = new Map<string, string>();
  for (const [name, value] of iterateUrlQueryParameters(query ?? "")) {
    if (values.has(name) && values.get(name) !== value) return undefined;
    values.set(name, value);
  }
  return compositeKey(
    [...values].sort(([left], [right]) => compare(left, right)),
  );
};

interface CheckedLine {
  readonly ordinal: number;
  readonly segments: readonly string[];
}

/** A list or document view's checked lines, by query, in the tool's recorded order, and which path segments are the tool's parameters. */
export interface CheckedLines {
  readonly params: ReadonlySet<number>;
  readonly byQuery: ReadonlyMap<string, readonly CheckedLine[]>;
  /** The lines listing their whole collection that only page it, which serving answers a call supplying no query from. */
  readonly unfiltered: readonly CheckedLine[];
  /** For a list with a query: the names with a learned role, and the query and whole lines serving evaluates new values on. */
  readonly query?: {
    readonly roles: ReadonlySet<string>;
    readonly lines: readonly CheckedLine[];
  };
}

/** The line a read's call is answered from, and the collection serving lists for it. */
export interface ServedLine {
  readonly ordinal: number;
  readonly collection: string;
  /** Whether the read's query names the line; serving answers a read on any other line in that line's envelope. */
  readonly named: boolean;
  /** Set when serving evaluates the read's own query values on a line it did not name. */
  readonly queried?: boolean;
}

type LineMatch = Pick<ServedLine, "ordinal" | "collection">;

/** Each list or document view's checked lines. */
export const checkedLines = (input: {
  readonly tools: readonly StateToolFacts[];
  readonly records: readonly StateRecordFacts[];
  readonly views: ReadonlyMap<string, StateView>;
}): Map<string, CheckedLines> => {
  const byOrdinal = new Map(
    input.records.map((record) => [record.ordinal, record]),
  );
  const tools = new Map(input.tools.map((tool) => [tool.name, tool]));
  const byView = new Map<string, CheckedLines>();
  for (const view of input.views.values()) {
    const tool = tools.get(view.tool);
    if (view.shape === "recorded" || view.shape === "item" || !tool) continue;
    const checked = new Set(view.checked_record_ordinals);
    const byQuery = new Map<string, CheckedLine[]>();
    const unfiltered: CheckedLine[] = [];
    for (const ordinal of tool.record_ordinals) {
      const record = byOrdinal.get(ordinal);
      const key = record === undefined ? undefined : queryKey(record.query);
      if (!checked.has(ordinal) || key === undefined) continue;
      const line = { ordinal, segments: segmentsOf(record!.path) };
      byQuery.set(key, [...(byQuery.get(key) ?? []), line]);
      if (
        view.shape === "list" &&
        listsAll(view, ordinal) &&
        pagesOnly(record!.query)
      )
        unfiltered.push(line);
    }
    const params = new Set(
      segmentsOf(tool.path_template).flatMap((segment, index) =>
        isParam(segment) ? [index] : [],
      ),
    );
    const query =
      view.shape === "list" && view.query !== undefined
        ? {
            roles: new Set(Object.keys(view.query.parameters)),
            lines: [...view.query.record_ordinals, ...allLines(view)].flatMap(
              (ordinal) => {
                const record = byOrdinal.get(ordinal);
                return record === undefined
                  ? []
                  : [{ ordinal, segments: segmentsOf(record.path) }];
              },
            ),
          }
        : undefined;
    byView.set(view.tool, {
      params,
      byQuery,
      unfiltered,
      ...(query === undefined ? {} : { query }),
    });
  }
  return byView;
};

/**
 * The checked line serving answers a read's call from, ranked as replay ranks lines: every
 * parameter the read's value verbatim or once percent-decoded and the query the read's, then the
 * most verbatim parameters, then recorded order. A read with no query falls back, as serving does,
 * on a whole list's lines that only page it.
 */
export const servedLine = (
  lines: CheckedLines | undefined,
  record: StateRecordFacts,
): ServedLine | undefined => {
  const key = queryKey(record.query);
  if (lines === undefined || key === undefined) return undefined;
  const names = [...iterateUrlQueryParameters(record.query ?? "")].map(
    ([name]) => name,
  );
  const named = bestLine(lines, lines.byQuery.get(key) ?? [], record);
  if (named !== undefined) return { ...named, named: true };
  const unfiltered =
    names.length === 0 ? bestLine(lines, lines.unfiltered, record) : undefined;
  if (unfiltered !== undefined) return { ...unfiltered, named: false };
  if (lines.query === undefined) return undefined;
  // As serving does, a read whose every query name has a role answers on a query or whole line, on its own values.
  const { roles } = lines.query;
  if (!names.every((name) => roles.has(name))) return undefined;
  const line = bestLine(lines, lines.query.lines, record);
  return line === undefined
    ? undefined
    : { ...line, named: false, queried: names.length > 0 };
};

const bestLine = (
  lines: CheckedLines,
  candidates: readonly CheckedLine[],
  record: StateRecordFacts,
): LineMatch | undefined => {
  const read = segmentsOf(record.path);
  let best: { line: LineMatch; verbatim: number } | undefined;
  for (const { ordinal, segments } of candidates) {
    if (segments.length !== read.length) continue;
    let verbatim = 0;
    const matches = segments.every((segment, index) => {
      if (segment === read[index]) {
        if (lines.params.has(index)) verbatim += 1;
        return true;
      }
      return lines.params.has(index) && decodedSegment(segment) === read[index];
    });
    if (matches && (best === undefined || verbatim > best.verbatim))
      best = {
        line: { ordinal, collection: `/${segments.join("/")}` },
        verbatim,
      };
  }
  return best?.line;
};
