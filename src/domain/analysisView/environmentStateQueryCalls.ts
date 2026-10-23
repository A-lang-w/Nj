import { identifierWords } from "./environmentStateWords.js";
import type { JsonValue } from "../jsonValue.js";
import {
  changesState,
  isObject,
  isParam,
  isStateWrite,
  QUERY_SEGMENTS,
  same,
  segmentsOf,
  type StateRecordFacts,
  type StateToolFacts,
} from "./environmentStateRules.js";
import { isAbsence } from "./environmentStateWriteChecks.js";
import { prefixRelated } from "./environmentStateWriteRules.js";

/** The words of a segment or operation name. */
const words = identifierWords;

/** Path words that name a lookup rather than a change. */
const QUERY_WORDS = new Set([
  ...[...QUERY_SEGMENTS].flatMap(words),
  "ids",
  "selection",
  "discover",
]);
/** Trailing words that only qualify what a segment names, so the word before them decides. */
const NEUTRAL_WORDS = new Set(["data", "info", "results"]);
/** Whole path segments that renew or open a session rather than change state. */
const SESSION_SEGMENTS = new Set([
  "auth-refresh",
  "auth-with-password",
  "login",
  "logout",
  "refresh",
  "token",
]);
const READ_OPERATION_WORDS = new Set([
  "list",
  "get",
  "count",
  "aggregate",
  "info",
  "search",
  "find",
  "read",
  "query",
  "schema",
  "describe",
  "fetch",
  "lookup",
]);
const WRITE_OPERATION_WORDS = new Set([
  "create",
  "insert",
  "update",
  "modify",
  "replace",
  "delete",
  "remove",
  "upsert",
  "add",
  "set",
  "save",
  "patch",
  "put",
  "post",
  "write",
  "move",
  "copy",
  "duplicate",
  "import",
  "run",
  "execute",
  "trigger",
  "send",
  "reset",
  "clear",
  "archive",
  "restore",
]);
/** Operation names that only wrap the operations a request body names. */
const OPERATION_CONTAINERS = new Set(["batch", "bulk", "multi"]);
const OPERATION_PARAMETERS = ["operation", "op", "action"];

/** What deciding read-only calls reads besides the tools and the timeline. */
export interface QueryCallIo {
  readonly response: (ordinal: number) => JsonValue | undefined;
  readonly request: (ordinal: number) => JsonValue | undefined;
}

const succeeded = (record: StateRecordFacts): boolean =>
  record.status !== null && record.status >= 200 && record.status < 300;

/** A call that may have changed state without a 2xx answer saying what it did: redirected or unanswered. */
const unresolved = (record: StateRecordFacts): boolean =>
  isStateWrite(record) && !succeeded(record);

/** Whether a name is an operation's: a string that is no container wrapping others. */
const isOperation = (name: JsonValue | undefined): name is string =>
  typeof name === "string" && !OPERATION_CONTAINERS.has(name.toLowerCase());

/** The names among these that are operations rather than containers wrapping them. */
const realOperations = (names: readonly (JsonValue | undefined)[]): string[] =>
  names.filter(isOperation);

/**
 * The operations an RPC call names: its body's `operation` or `operations[].operation`, else its
 * query's, containers aside. Undefined when `operations` is no list or one of its entries names no
 * operation of its own: no string, or another container.
 */
const operationsOf = (
  record: StateRecordFacts,
  body: JsonValue | undefined,
): string[] | undefined => {
  const listed = isObject(body) ? body.operations : undefined;
  const entries = Array.isArray(listed)
    ? listed.map((entry) => (isObject(entry) ? entry.operation : undefined))
    : [];
  if (
    (listed !== undefined && !Array.isArray(listed)) ||
    !entries.every(isOperation)
  )
    return undefined;
  const named = isObject(body)
    ? realOperations([body.operation, ...entries])
    : [];
  if (named.length > 0) return named;
  const query = new URLSearchParams(record.query ?? "");
  return realOperations(
    OPERATION_PARAMETERS.flatMap((name) => query.getAll(name)),
  );
};

/** An operation that reads: it names a read word and no write word. */
const readsOnly = (operation: string): boolean => {
  const named = words(operation);
  return (
    named.some((word) => READ_OPERATION_WORDS.has(word)) &&
    !named.some((word) => WRITE_OPERATION_WORDS.has(word))
  );
};

/**
 * POST tools whose recorded calls read state rather than change it, by the strongest evidence that
 * applies: a response repeating the latest read of the same path finished before it, with no write
 * between, an RPC tunnel naming only read operations, a last path word naming a lookup, or a session
 * segment. A tool with a redirected or unanswered call stays a write, as does one a read line its
 * path relates to changes across or finds gone after, no write but the other read-only tools' calls between.
 */
export const readOnlyTools = (
  tools: readonly StateToolFacts[],
  records: readonly StateRecordFacts[],
  io: QueryCallIo,
): Set<string> => {
  const position = new Map(
    records.map((record, index) => [record.ordinal, index]),
  );
  /** The timeline indexes of the nearest state writes either side of an index, the skipped calls aside: -1 and the length when none, found in one pass each way. */
  const nearestWrites = (
    skip: ReadonlySet<number>,
  ): ((at: number) => { readonly before: number; readonly after: number }) => {
    const writes = records.map(
      (record) => !skip.has(record.ordinal) && isStateWrite(record),
    );
    const before: number[] = [];
    const after: number[] = Array.from({ length: records.length });
    for (let index = 0, last = -1; index < records.length; index += 1) {
      before.push(last);
      if (writes[index]) last = index;
    }
    for (
      let index = records.length - 1, next = records.length;
      index >= 0;
      index -= 1
    ) {
      after[index] = next;
      if (writes[index]) next = index;
    }
    return (at) => ({ before: before[at]!, after: after[at]! });
  };
  const candidates = new Map<string, readonly StateRecordFacts[]>();
  for (const tool of tools) {
    if (
      tool.method !== "POST" ||
      !changesState(tool.method, tool.path_template)
    )
      continue;
    const calls = tool.record_ordinals
      .map((ordinal) => records[position.get(ordinal) ?? -1])
      .filter((record): record is StateRecordFacts => record !== undefined);
    if (!calls.some(succeeded) || calls.some(unresolved)) continue;
    const writes = nearestWrites(new Set(tool.record_ordinals));
    if (
      repeatsRead(calls, records, { position, writes, io }) ||
      namesReadOperations(calls, io) ||
      namesLookup(tool.path_template)
    )
      candidates.set(tool.name, calls);
  }
  // No candidate's call explains a read change across another's, so drop vetoed candidates until none is.
  for (let vetoed = true; vetoed;) {
    const writes = nearestWrites(
      new Set([...candidates.values()].flat().map((call) => call.ordinal)),
    );
    vetoed = false;
    for (const [name, calls] of candidates)
      if (changesReadsAcross(calls, records, { position, writes, io })) {
        candidates.delete(name);
        vetoed = true;
      }
  }
  return new Set(candidates.keys());
};

interface Timeline {
  readonly position: ReadonlyMap<number, number>;
  /** The nearest other writes either side of a timeline index. */
  readonly writes: (at: number) => {
    readonly before: number;
    readonly after: number;
  };
  readonly io: QueryCallIo;
}

/** Of these reads, the one that finished last before `call` began, a later one on a tie; records come in start order. */
const lastFinishedBefore = (
  reads: readonly StateRecordFacts[],
  call: StateRecordFacts,
): StateRecordFacts | undefined => {
  let latest: StateRecordFacts | undefined;
  for (const read of reads)
    if (
      read.end <= call.start &&
      (latest === undefined || read.end >= latest.end)
    )
      latest = read;
  return latest;
};

/** Every successful call answers as the successful GET of its path that finished last before it began, of those with no write between, did. */
const repeatsRead = (
  calls: readonly StateRecordFacts[],
  records: readonly StateRecordFacts[],
  { position, writes, io }: Timeline,
): boolean =>
  calls.filter(succeeded).every((call) => {
    const at = position.get(call.ordinal)!;
    // Only reads after the last other write show the state the call met.
    const read = lastFinishedBefore(
      records
        .slice(writes(at).before + 1, at)
        .filter(
          (record) =>
            record.method === "GET" &&
            record.path === call.path &&
            succeeded(record),
        ),
      call,
    );
    if (read === undefined) return false;
    const answered = io.response(call.ordinal);
    return answered !== undefined && same(answered, io.response(read.ordinal));
  });

/** Every call names only read operations. */
const namesReadOperations = (
  calls: readonly StateRecordFacts[],
  io: QueryCallIo,
): boolean =>
  calls.every((call) => {
    const operations = operationsOf(call, io.request(call.ordinal));
    return (
      operations !== undefined &&
      operations.length > 0 &&
      operations.every(readsOnly)
    );
  });

/** The path's last literal segment is a session segment, or names a lookup by its last meaningful word and no write word. */
const namesLookup = (template: string): boolean => {
  const last = segmentsOf(template).findLast((segment) => !isParam(segment));
  if (last === undefined) return false;
  return (
    SESSION_SEGMENTS.has(last.toLowerCase()) ||
    (QUERY_WORDS.has(lastMeaningfulWord(last) ?? "") &&
      !words(last).some((word) => WRITE_OPERATION_WORDS.has(word)))
  );
};

/** A segment's last word that is not a trailing neutral word: `selection_data` names a selection, `query-history` a history. */
const lastMeaningfulWord = (segment: string): string | undefined =>
  words(segment).findLast((word) => !NEUTRAL_WORDS.has(word));

/**
 * A GET line whose path a call's path relates to reads differently, or finds its entity present on one
 * side only, just before and just after it, with no other write between: the read that finished last
 * before it began and the first begun after it ended, since one overlapping it may show either state.
 * Calls in one write-free stretch under one path share a pass over it, and only lines whose reads
 * there disagree can change across a call.
 */
const changesReadsAcross = (
  calls: readonly StateRecordFacts[],
  records: readonly StateRecordFacts[],
  { position, writes, io }: Timeline,
): boolean => {
  const stretches = new Map<
    string,
    { from: number; to: number; path: string; calls: StateRecordFacts[] }
  >();
  for (const call of calls.filter(succeeded)) {
    const { before, after } = writes(position.get(call.ordinal)!);
    const key = JSON.stringify([before, after, call.path]);
    const stretch = stretches.get(key);
    if (stretch === undefined)
      stretches.set(key, {
        from: before,
        to: after,
        path: call.path,
        calls: [call],
      });
    else stretch.calls.push(call);
  }
  for (const stretch of stretches.values())
    if (changesInStretch(stretch, records, { position, io })) return true;
  return false;
};

/** Whether a related line changes across one of these calls, all between the same two writes under one path. */
const changesInStretch = (
  stretch: {
    readonly from: number;
    readonly to: number;
    readonly path: string;
    readonly calls: readonly StateRecordFacts[];
  },
  records: readonly StateRecordFacts[],
  { position, io }: Pick<Timeline, "position" | "io">,
): boolean => {
  const shown = (record: StateRecordFacts): JsonValue | symbol => {
    if (!succeeded(record)) return ABSENT;
    const body = io.response(record.ordinal);
    return body === undefined ? UNKNOWN : body;
  };
  const lines = new Map<string, StateRecordFacts[]>();
  for (let index = stretch.from + 1; index < stretch.to; index += 1) {
    const record = records[index]!;
    if (
      record.method !== "GET" ||
      !(succeeded(record) || isAbsence(record.status)) ||
      !prefixRelated(stretch.path, record.path)
    )
      continue;
    const line = `${record.path}${record.query ?? ""}`;
    const reads = lines.get(line);
    if (reads === undefined) lines.set(line, [record]);
    else reads.push(record);
  }
  // A line whose reads all show one thing cannot change across any call.
  const changing = [...lines.values()].filter((reads) => {
    const first = shown(reads[0]!);
    return reads.some((read) => !sameShown(first, shown(read)));
  });
  return stretch.calls.some((call) => {
    const at = position.get(call.ordinal)!;
    return changing.some((reads) => {
      const earlier = lastFinishedBefore(
        reads.filter((read) => position.get(read.ordinal)! < at),
        call,
      );
      const later = reads.find(
        (read) => position.get(read.ordinal)! > at && read.start >= call.end,
      );
      if (earlier === undefined || later === undefined) return false;
      const [was, now] = [shown(earlier), shown(later)];
      // Presence on one side only is a change even when a body is unusable.
      if ((was === ABSENT) !== (now === ABSENT)) return true;
      return was !== UNKNOWN && now !== UNKNOWN && !sameShown(was, now);
    });
  });
};

/** A read that found its entity gone, and one whose body is unusable. */
const ABSENT = Symbol("absent");
const UNKNOWN = Symbol("unknown");

const sameShown = (
  left: JsonValue | symbol,
  right: JsonValue | symbol,
): boolean =>
  typeof left === "symbol" || typeof right === "symbol"
    ? left === right
    : same(left, right);

/** The timeline's state writes, less the calls of tools whose calls only read, and those tools. */
export const stateWritesOf = (
  tools: readonly StateToolFacts[],
  records: readonly StateRecordFacts[],
  io: QueryCallIo,
): {
  readonly readOnly: ReadonlySet<string>;
  readonly writes: readonly StateRecordFacts[];
} => {
  const readOnly = readOnlyTools(tools, records, io);
  const reads = new Set(
    tools
      .filter((tool) => readOnly.has(tool.name))
      .flatMap((tool) => tool.record_ordinals),
  );
  return {
    readOnly,
    writes: records.filter(
      (record) => isStateWrite(record) && !reads.has(record.ordinal),
    ),
  };
};
