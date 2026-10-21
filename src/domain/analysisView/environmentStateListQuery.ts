import type { JsonValue } from "../jsonValue.js";
import { compareUnicodeCodePoints as compare } from "../unicodeCodePointOrder.js";
import {
  isObject,
  pointerTo,
  renderStateList,
  replaceAt,
  scalarText,
  type JsonObject,
  type StateEntity,
  type StateListView,
} from "./environmentStateRules.js";

/** What one list query parameter does to a list, learned from the recorded lines it explains. */
export type QueryParameter =
  | { readonly role: "filter"; readonly field: string }
  | { readonly role: "search"; readonly fields: string[] }
  | { readonly role: "sort" }
  | { readonly role: "direction" }
  | { readonly role: "limit" }
  | { readonly role: "offset" }
  | { readonly role: "page"; readonly first: number }
  | { readonly role: "inert"; readonly values: string[] };

/** A list view's query model: each parameter's role, the checked lines it answers, and the members that count matches before paging. */
export interface ListQuery {
  readonly parameters: Record<string, QueryParameter>;
  readonly record_ordinals: number[];
  readonly totals: string[];
}

/** One recorded line a query may explain: its query values, the identities it listed in order, the roles each parameter may play and the collection's entities. */
export interface QueryLine {
  readonly ordinal: number;
  readonly values: ReadonlyMap<string, string>;
  readonly listed: readonly string[];
  readonly choices: readonly (readonly [string, readonly QueryParameter[]])[];
  readonly entities: readonly StateEntity[];
}

const SORT = new Set([
  "order",
  "orderby",
  "order_by",
  "ordering",
  "sort",
  "sortby",
  "sort_by",
]);
const DIRECTION = new Set([
  "dir",
  "direction",
  "order",
  "orderdirection",
  "order_direction",
  "sortdir",
  "sort_dir",
  "sortorder",
  "sort_order",
]);
const LIMIT = new Set([
  "count",
  "itemsperpage",
  "limit",
  "page_size",
  "pagesize",
  "per_page",
  "perpage",
  "size",
  "take",
]);
const OFFSET = new Set(["_start", "offset", "skip", "start"]);
const SEARCH = new Set([
  "keyword",
  "keywords",
  "q",
  "query",
  "search",
  "search_term",
  "searchterm",
  "term",
]);
const DIRECTIONS = new Set(["asc", "desc"]);
const IDENTIFYING = ["id", "slug", "name"];
/** At most this many role combinations are tried for one line. */
const MAX_COMBINATIONS = 256;

/** A request's query values, decoded, or undefined when a parameter repeats. */
export const queryValues = (
  query: string | undefined,
): Map<string, string> | undefined => {
  const values = new Map<string, string>();
  for (const [name, value] of new URLSearchParams(query ?? "")) {
    if (values.has(name)) return undefined;
    values.set(name, value);
  }
  return values;
};

const textOf = (value: JsonValue | undefined): string | undefined =>
  typeof value === "boolean" ? String(value) : scalarText(value);

/** Whether a field holds a value: equal as text, or in an array directly or as an object's id, slug or name. */
const holds = (field: JsonValue | undefined, value: string): boolean => {
  const names = (item: JsonValue | undefined) =>
    isObject(item) && IDENTIFYING.some((key) => textOf(item[key]) === value);
  return Array.isArray(field)
    ? field.some((item) => textOf(item) === value || names(item))
    : textOf(field) === value || names(field);
};

const contains = (
  entity: StateEntity,
  fields: readonly string[],
  term: string,
): boolean => {
  const needle = term.toLowerCase();
  return (
    needle === "" ||
    fields.some((field) => {
      const value = entity.fields[field];
      return typeof value === "string" && value.toLowerCase().includes(needle);
    })
  );
};

const normalized = (name: string): string =>
  name.toLowerCase().replace(/[^a-z0-9]/gu, "");

/** The field a sort value names and its direction: `name`, `-name`, `name:desc`, `name-ASC`; names match ignoring case and separators. */
const sortKey = (
  value: string,
  names: readonly string[],
): { readonly field: string; readonly descending: boolean } | undefined => {
  const field = (spelled: string) => {
    if (names.includes(spelled)) return spelled;
    const found = names.filter(
      (name) => normalized(name) === normalized(spelled),
    );
    return found.length === 1 ? found[0] : undefined;
  };
  const whole = field(value);
  if (whole !== undefined) return { field: whole, descending: false };
  if (value.startsWith("-")) {
    const named = field(value.slice(1));
    return named === undefined ? undefined : { field: named, descending: true };
  }
  const suffixed = /^(.+?)[\s:_-](asc|desc)$/iu.exec(value);
  const named = suffixed === null ? undefined : field(suffixed[1]!);
  return named === undefined
    ? undefined
    : { field: named, descending: suffixed![2]!.toLowerCase() === "desc" };
};

/** Ascending order: numbers by value, text ignoring case, missing and null values last. */
const ascending = (
  left: JsonValue | undefined,
  right: JsonValue | undefined,
): number => {
  const absent = (value: JsonValue | undefined) =>
    value === undefined || value === null;
  if (absent(left) || absent(right))
    return absent(left) ? (absent(right) ? 0 : 1) : -1;
  if (typeof left === "number" && typeof right === "number")
    return left - right;
  const a = textOf(left) ?? JSON.stringify(left);
  const b = textOf(right) ?? JSON.stringify(right);
  return compare(a.toLowerCase(), b.toLowerCase()) || compare(a, b);
};

const integer = (value: string): number | undefined =>
  /^-?\d{1,9}$/u.test(value) ? Number(value) : undefined;

/** The entities a query selects, in its order, and how many matched before paging; undefined when a value cannot be applied. */
export const evaluateQuery = (
  parameters: Readonly<Record<string, QueryParameter>>,
  values: ReadonlyMap<string, string>,
  entities: readonly StateEntity[],
): { readonly page: StateEntity[]; readonly total: number } | undefined => {
  let matched = [...entities];
  let sort: string | undefined;
  let direction: string | undefined;
  let limit: number | undefined;
  let offset = 0;
  let page: { readonly index: number; readonly first: number } | undefined;
  for (const [name, value] of values) {
    const parameter = parameters[name];
    const number = integer(value);
    if (parameter === undefined) return undefined;
    if (parameter.role === "filter")
      matched = matched.filter((entity) =>
        holds(entity.fields[parameter.field], value),
      );
    else if (parameter.role === "search")
      matched = matched.filter((entity) =>
        contains(entity, parameter.fields, value),
      );
    else if (parameter.role === "sort") sort = value;
    else if (parameter.role === "direction") {
      if (!DIRECTIONS.has(value.toLowerCase())) return undefined;
      direction = value.toLowerCase();
    } else if (parameter.role === "inert") {
      if (!parameter.values.includes(value)) return undefined;
    } else if (number === undefined) return undefined;
    else if (parameter.role === "limit")
      limit = number > 0 ? number : undefined;
    else if (parameter.role === "offset" && number >= 0) offset = number;
    else if (parameter.role === "page" && number >= parameter.first)
      page = { index: number, first: parameter.first };
    else return undefined;
  }
  if (sort !== undefined) {
    const names = [
      ...new Set(entities.flatMap((entity) => Object.keys(entity.fields))),
    ];
    const key = sortKey(sort, names);
    if (key === undefined) return undefined;
    const descending =
      direction === undefined ? key.descending : direction === "desc";
    matched = matched
      .map((entity, index) => ({ entity, index }))
      .sort(
        (left, right) =>
          (descending ? -1 : 1) *
            ascending(
              left.entity.fields[key.field],
              right.entity.fields[key.field],
            ) || left.index - right.index,
      )
      .map(({ entity }) => entity);
  }
  if (page !== undefined && page.index > page.first) {
    if (limit === undefined) return undefined;
    offset += (page.index - page.first) * limit;
  }
  return {
    page: matched.slice(
      offset,
      limit === undefined ? undefined : offset + limit,
    ),
    total: matched.length,
  };
};

/** Fields every listed item holds the value in, those named like the parameter first. */
const filterFields = (
  items: readonly JsonObject[],
  name: string,
  value: string,
): string[] =>
  items.length === 0
    ? []
    : Object.keys(items[0]!)
        .filter((field) => items.every((item) => holds(item[field], value)))
        .sort(
          (left, right) =>
            Number(normalized(right) === normalized(name)) -
            Number(normalized(left) === normalized(name)),
        )
        .slice(0, 4);

/** String fields that contain the term in at least one listed item. */
const searchFields = (items: readonly JsonObject[], term: string): string[] =>
  term === ""
    ? []
    : [
        ...new Set(
          items.flatMap((item) =>
            Object.keys(item).filter((field) => {
              const value = item[field];
              return (
                typeof value === "string" &&
                value.toLowerCase().includes(term.toLowerCase())
              );
            }),
          ),
        ),
      ].sort(compare);

/** The roles a parameter may play on a line that listed `items`, most specific first; inert last. */
const choicesFor = (
  name: string,
  value: string,
  items: readonly JsonObject[],
): QueryParameter[] => {
  const key = name.toLowerCase();
  const choices: QueryParameter[] = [];
  if (DIRECTION.has(key) && DIRECTIONS.has(value.toLowerCase()))
    choices.push({ role: "direction" });
  else if (SORT.has(key)) choices.push({ role: "sort" });
  else if (LIMIT.has(key)) choices.push({ role: "limit" });
  else if (OFFSET.has(key)) choices.push({ role: "offset" });
  else if (key === "page")
    choices.push({ role: "page", first: 1 }, { role: "page", first: 0 });
  else if (SEARCH.has(key))
    choices.push({ role: "search", fields: searchFields(items, value) });
  if (choices.length === 0 || SEARCH.has(key))
    for (const field of filterFields(items, name, value))
      choices.push({ role: "filter", field });
  choices.push({ role: "inert", values: [value] });
  return choices;
};

/** The roles each of a line's parameters may play, read from the items it listed. */
export const lineChoices = (
  values: ReadonlyMap<string, string>,
  items: readonly JsonObject[],
): [string, QueryParameter[]][] =>
  [...values].map(([name, value]) => [name, choicesFor(name, value, items)]);

const listsAsRecorded = (
  line: QueryLine,
  parameters: Readonly<Record<string, QueryParameter>>,
): boolean => {
  const result = evaluateQuery(parameters, line.values, line.entities);
  return (
    result !== undefined &&
    result.page.length === line.listed.length &&
    result.page.every((entity, index) => entity.id === line.listed[index])
  );
};

/** The first combination of roles, most specific first, that lists exactly what the line recorded. */
export const explainLine = (
  line: QueryLine,
): Record<string, QueryParameter> | undefined => {
  const options = line.choices;
  let tried = 0;
  const search = (
    index: number,
    chosen: Record<string, QueryParameter>,
  ): Record<string, QueryParameter> | undefined => {
    if (index === options.length) {
      tried += 1;
      return listsAsRecorded(line, chosen) ? chosen : undefined;
    }
    const [name, choices] = options[index]!;
    for (const choice of choices) {
      if (tried >= MAX_COMBINATIONS) return undefined;
      const found = search(index + 1, { ...chosen, [name]: choice });
      if (found !== undefined) return found;
    }
    return undefined;
  };
  return search(0, {});
};

/** One role per parameter across the lines that explained it: inert values gather, search fields unite, and any other disagreement drops the parameter. */
const mergeRoles = (
  explained: readonly Record<string, QueryParameter>[],
): Record<string, QueryParameter> => {
  const roles = new Map<string, QueryParameter[]>();
  for (const parameters of explained)
    for (const [name, role] of Object.entries(parameters))
      roles.set(name, [...(roles.get(name) ?? []), role]);
  const merged: Record<string, QueryParameter> = {};
  for (const [name, seen] of roles) {
    const active = seen.filter((role) => role.role !== "inert");
    if (active.length === 0) {
      merged[name] = {
        role: "inert",
        values: [
          ...new Set(
            seen.flatMap((role) => (role.role === "inert" ? role.values : [])),
          ),
        ].sort(compare),
      };
      continue;
    }
    const [first] = active;
    if (first!.role === "search") {
      if (active.every((role) => role.role === "search"))
        merged[name] = {
          role: "search",
          fields: [
            ...new Set(
              active.flatMap((role) =>
                role.role === "search" ? role.fields : [],
              ),
            ),
          ].sort(compare),
        };
      continue;
    }
    if (active.every((role) => JSON.stringify(role) === JSON.stringify(first)))
      merged[name] = first!;
  }
  return merged;
};

/** The query model that lists exactly what each explained line recorded, or undefined when none does. */
export const learnQuery = (
  lines: readonly QueryLine[],
): Pick<ListQuery, "parameters" | "record_ordinals"> | undefined => {
  const explained = lines.flatMap((line) => {
    const parameters = explainLine(line);
    return parameters === undefined ? [] : [parameters];
  });
  if (explained.length === 0) return undefined;
  const parameters = mergeRoles(explained);
  const record_ordinals = lines
    .filter((line) => listsAsRecorded(line, parameters))
    .map((line) => line.ordinal);
  return record_ordinals.length === 0
    ? undefined
    : { parameters, record_ordinals };
};

/** A query answer: the base line's envelope with the selected entities, counters at the number listed and totals at the number matched. */
export const renderQueryList = (
  view: Pick<StateListView, "pointer" | "counters"> & {
    readonly query: Pick<ListQuery, "totals">;
  },
  base: JsonValue,
  items: readonly JsonObject[],
  total: number,
): JsonValue =>
  view.query.totals.reduce(
    (body, name) => replaceAt(body, pointerTo(name), total),
    renderStateList(view, base, items),
  );
