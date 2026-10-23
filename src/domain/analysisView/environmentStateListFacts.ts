import type { JsonValue } from "../jsonValue.js";
import { compareUnicodeCodePoints as compare } from "../unicodeCodePointOrder.js";
import type { StateGateContext, StatePlan } from "./environmentStateGate.js";
import { startsAtBeginning } from "./environmentStatePaging.js";
import {
  envelopeMembers,
  mintedFor,
} from "./environmentStateResponseMembers.js";
import {
  collectionPathOf,
  isObject,
  listItems,
  same,
  scalarText,
  type JsonObject,
} from "./environmentStateRules.js";

/** The latest recordings that list their whole collection in state order, and the counters that equal the item count on each of them, or on every line when none does. */
export const listFacts = (
  context: StateGateContext,
  plan: StatePlan,
  union: { add(object: JsonObject): void },
): {
  readonly whole: ReadonlySet<number>;
  readonly counters: string[];
  readonly minted: string[];
} => {
  const field = context.idField(plan.type);
  const whole = new Set<number>();
  const counting = new Map<number, string[]>();
  const names = mintedFor(context.minted, plan.latest, false);
  const minted = new Set<string>();
  for (const record of plan.latest)
    context.withBody(record.ordinal, (body) => {
      const items =
        body === undefined ? undefined : listItems(body, plan.pointer);
      if (body === undefined || items === undefined) return;
      for (const name of envelopeMembers(body, names, plan.pointer))
        minted.add(name);
      items.forEach((item) => union.add(item));
      const parent = plan.pointer === "" || !isObject(body) ? {} : body;
      const counted = Object.keys(parent).filter(
        (name) => isItemTotal(name) && countOf(parent[name]) !== undefined,
      );
      counting.set(
        record.ordinal,
        counted.filter((name) => parent[name] === items.length),
      );
      // Only a line that pages at most can hold its whole collection; a total that differs from
      // the number listed, or a next page, shows it is partial.
      if (
        !startsAtBeginning(record.query) ||
        counted.some((name) => countOf(parent[name]) !== items.length) ||
        Object.keys(parent).some((name) => continues(name, parent[name]))
      )
        return;
      const ids = items.map((item) => scalarText(item[field]) ?? "");
      const expected = context
        .inCollection(plan.type, collectionPathOf(record, false))
        .map((entity) => entity.id);
      if (same(ids, expected)) whole.add(record.ordinal);
    });
  // Counter presence is per envelope. Keep every observed page counter;
  // renderStateList updates only one the selected base actually counted.
  const counters = [...new Set([...counting.values()].flat())].sort(compare);
  return { whole, counters, minted: [...minted].sort(compare) };
};

export const nameTokens = (name: string): string[] =>
  name
    .split(/[_\-\s]|(?<=[a-z0-9])(?=[A-Z])/u)
    .map((token) => token.toLowerCase());

const LISTED_NOUNS = new Set(["elements", "entries", "items", "results"]);

/** Item totals, including compact `totalcount`/`itemcount` and `numberOfElements`; page counts and account IDs are excluded. */
export const isItemTotal = (name: string): boolean => {
  const tokens = nameTokens(name);
  return (
    (tokens.some(
      (token) =>
        token === "total" ||
        token === "count" ||
        token === "totalcount" ||
        token === "itemcount",
    ) ||
      (tokens.includes("number") &&
        tokens.some((token) => LISTED_NOUNS.has(token)))) &&
    !tokens.some(
      (token) => token === "page" || token === "pages" || token === "per",
    )
  );
};

/** A count recorded as a number or as a string of digits. */
const countOf = (value: JsonValue | undefined): number | undefined =>
  typeof value === "number"
    ? value
    : typeof value === "string" && /^\d+$/u.test(value)
      ? Number(value)
      : undefined;

const CONTINUATION_NAMES = new Set([
  "hasmore",
  "next",
  "nextcursor",
  "nextpage",
  "nextpagetoken",
  "nexttoken",
]);

/** A top-level `has_more`, `next` or next-page token member that says more items follow. */
const continues = (name: string, value: JsonValue | undefined): boolean =>
  CONTINUATION_NAMES.has(nameTokens(name).join("")) &&
  value !== undefined &&
  value !== null &&
  value !== false &&
  value !== "";
