import type { JsonValue } from "../jsonValue.js";
import {
  collectionPathOf,
  IDENTITY_NAMES,
  isObject,
  isParam,
  lastSegmentValue,
  normalizedPath,
  scalarText,
  segmentsOf,
  type StateEntity,
  type StateRecordFacts,
  type StateToolFacts,
  type StateView,
} from "./environmentStateRules.js";
import type { WriteEffect } from "./environmentStateWriteRules.js";

/** The shortest id that names one entity rather than counting one. */
const MIN_ID_LENGTH = 4;

const succeeded = (record: StateRecordFacts): boolean =>
  record.status !== null && record.status >= 200 && record.status < 300;

/** An object's identity-named scalar members. */
const identityValues = (object: JsonValue | undefined): string[] =>
  isObject(object)
    ? IDENTITY_NAMES.flatMap((name) => {
        const value = scalarText(object[name]);
        return value === undefined ? [] : [value];
      })
    : [];

/**
 * The ids a write's response names for an entity it made, long enough to name one: a scalar body,
 * an identity-named or sole scalar member, or an identity-named member of an object member (an envelope).
 */
export const respondedIds = (body: JsonValue | undefined): string[] => {
  if (body === undefined || body === null) return [];
  const ids: string[] = [];
  if (!isObject(body)) {
    const value = scalarText(body);
    if (value !== undefined) ids.push(value);
  } else {
    ids.push(...identityValues(body));
    const members = Object.values(body);
    const sole = members.length === 1 ? scalarText(members[0]) : undefined;
    if (sole !== undefined) ids.push(sole);
    for (const member of members) ids.push(...identityValues(member));
  }
  return [...new Set(ids)].filter((id) => id.length >= MIN_ID_LENGTH);
};

/** The identity-named scalar values a read's body shows at any depth, or its path's id for an item read. */
const shownIds = (
  record: StateRecordFacts,
  item: boolean,
  body: () => JsonValue | undefined,
): Set<string> => {
  if (item) return new Set([lastSegmentValue(record.path)]);
  const shown = new Set<string>();
  const pending: JsonValue[] = [];
  const root = body();
  if (root !== undefined) pending.push(root);
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    if (Array.isArray(next)) pending.push(...next);
    else if (isObject(next)) {
      for (const id of identityValues(next)) shown.add(id);
      pending.push(...Object.values(next));
    }
  }
  return shown;
};

/** A successful POST and the ids its response named. */
export interface CreatedIds {
  readonly record: StateRecordFacts;
  readonly ids: readonly string[];
}

/** The successful POSTs among a timeline's writes, with the ids their responses named. */
export const createdIdsOf = (
  writes: readonly StateRecordFacts[],
  idsOf: (ordinal: number) => string[],
): CreatedIds[] =>
  writes.flatMap((record) => {
    if (record.method !== "POST" || !succeeded(record)) return [];
    const ids = idsOf(record.ordinal);
    return ids.length === 0 ? [] : [{ record, ids }];
  });

/** The state type a GET tool reads and whether it reads one item: its path less a trailing parameter. */
export const readType = (
  template: string,
): { readonly item: boolean; readonly type: string } => {
  const segments = segmentsOf(template);
  const item = segments.length > 0 && isParam(segments.at(-1)!);
  return {
    item,
    type: item
      ? `/${segments.slice(0, -1).join("/")}`
      : normalizedPath(template),
  };
};

/**
 * The earliest POST that made an entity a type's reads first show after it, before `until`: such a
 * POST changes the type although its path is elsewhere, so it bounds the type's initial recordings.
 */
export const creationLimit = (
  creations: readonly CreatedIds[],
  reads: {
    readonly type: string;
    readonly tools: readonly StateToolFacts[];
    readonly records: ReadonlyMap<number, StateRecordFacts>;
    readonly position: (record: StateRecordFacts) => number;
    readonly body: (ordinal: number) => JsonValue | undefined;
  },
  until: StateRecordFacts | undefined,
): StateRecordFacts | undefined => {
  if (creations.length === 0) return undefined;
  const end = until === undefined ? Infinity : reads.position(until);
  const readers = reads.tools.flatMap((tool) => {
    const read = readType(tool.path_template);
    return tool.method === "GET" && read.type === reads.type
      ? [{ tool, item: read.item }]
      : [];
  });
  const shown = readers.flatMap(({ tool, item }) =>
    tool.record_ordinals.flatMap((ordinal) => {
      const record = reads.records.get(ordinal);
      return record === undefined || !succeeded(record)
        ? []
        : [
            {
              at: reads.position(record),
              ids: shownIds(record, item, () => reads.body(ordinal)),
            },
          ];
    }),
  );
  for (const creation of [...creations].sort(
    (left, right) => reads.position(left.record) - reads.position(right.record),
  )) {
    const at = reads.position(creation.record);
    if (at >= end) break;
    const fresh = creation.ids.filter(
      (id) =>
        !shown.some((read) => read.at < at && read.ids.has(id)) &&
        shown.some((read) => read.at > at && read.at < end && read.ids.has(id)),
    );
    if (fresh.length > 0) return creation.record;
  }
  return undefined;
};

/**
 * The state type and collection a POST whose path names none creates into: that of the first later
 * successful item read naming an id its first successful call returned, when neither the initial
 * state nor any earlier read held that id.
 */
export const linkedCreate = (input: {
  readonly tool: StateToolFacts;
  readonly records: readonly StateRecordFacts[];
  readonly viewOf: (ordinal: number) => StateView | undefined;
  readonly entities: readonly StateEntity[];
  readonly respondedIds: (ordinal: number) => readonly string[];
}): { readonly type: string; readonly collection: string } | undefined => {
  const { tool, records } = input;
  const own = new Set(tool.record_ordinals);
  const first = records.findIndex(
    (record) => own.has(record.ordinal) && succeeded(record),
  );
  if (first === -1) return undefined;
  const ids = new Set(input.respondedIds(records[first]!.ordinal));
  if (ids.size === 0) return undefined;
  for (const record of records.slice(0, first))
    if (
      record.method === "GET" &&
      succeeded(record) &&
      ids.has(lastSegmentValue(record.path))
    )
      return undefined;
  for (const record of records.slice(first + 1)) {
    const view = input.viewOf(record.ordinal);
    if (
      record.method !== "GET" ||
      !succeeded(record) ||
      view?.shape !== "item" ||
      !ids.has(lastSegmentValue(record.path))
    )
      continue;
    const id = lastSegmentValue(record.path);
    const held = input.entities.some(
      (entity) => entity.type === view.type && entity.id === id,
    );
    return held
      ? undefined
      : { type: view.type, collection: collectionPathOf(record, true) };
  }
  return undefined;
};

/** The collection a create plan writes into when its tool's own path names no state type: the one its returned id was read under. */
export const linkedCollection = (
  plan: {
    readonly effect: string;
    readonly target: string | null;
    readonly collection: string | null;
  },
  template: string,
): string | undefined =>
  plan.effect === "create" &&
  plan.target !== null &&
  plan.collection !== null &&
  plan.target !== normalizedPath(template)
    ? plan.collection
    : undefined;

/** A write's effect and target, where a POST its path gives no target becomes a create into the type its returned id is first read under. */
export const linkedTarget = (
  tool: StateToolFacts,
  classified: { readonly effect: WriteEffect; readonly target: string | null },
  input: {
    readonly records: readonly StateRecordFacts[];
    readonly viewOf: (ordinal: number) => StateView | undefined;
    readonly entities: readonly StateEntity[];
    readonly io: {
      readonly withBody: <T>(
        ordinal: number,
        use: (body: JsonValue | undefined) => T,
      ) => T;
    };
  },
): {
  readonly effect: WriteEffect;
  readonly target: string | null;
  readonly collection?: string;
} => {
  const link =
    classified.effect === "none" && tool.method === "POST"
      ? linkedCreate({
          tool,
          records: input.records,
          viewOf: input.viewOf,
          entities: input.entities,
          respondedIds: (ordinal) => input.io.withBody(ordinal, respondedIds),
        })
      : undefined;
  return link === undefined
    ? classified
    : { effect: "create", target: link.type, collection: link.collection };
};
