import type { JsonValue } from "../jsonValue.js";
import { compositeKey } from "../unicodeCodePointOrder.js";
import {
  at,
  collectionPathOf,
  decodedSegment,
  isObject,
  lastSegmentValue,
  listItems,
  listsAll,
  missingRequiredFields,
  renderStateEntity,
  renderStateList,
  replaceAt,
  same,
  scalarText,
  type JsonObject,
  type StateDocument,
  type StateEntity,
  type StateItemView,
  type StateListView,
  type StateRecordFacts,
  segmentsOf,
} from "./environmentStateRules.js";
import { pageSize } from "./environmentStatePaging.js";
import {
  answerQuery,
  queryValues,
  renderQueryList,
} from "./environmentStateListQuery.js";
import type { ServedLine } from "./environmentStateCheckedLines.js";
import { insertIndex } from "./environmentStateWriteExplain.js";
import type { InsertRule } from "./environmentStateWriteRules.js";

export const entityTarget = (type: string, collection: string, id: string) =>
  `e${compositeKey([type, collection, id])}`;
export const collectionTarget = (type: string, collection: string) =>
  `c${compositeKey([type, collection])}`;
export const documentTarget = (tool: string) => `d${compositeKey([tool])}`;

/** The gate's copy of the state: entities in collection order and documents, changed by modelled writes. */
export class SimulatedState {
  readonly #entities = new Map<string, StateEntity>();
  readonly #collections = new Map<string, string[]>();
  readonly #documents = new Map<string, JsonValue>();

  constructor(
    entities: readonly StateEntity[],
    documents: readonly StateDocument[],
  ) {
    for (const entity of entities) this.put(entity);
    for (const document of documents)
      this.#documents.set(document.tool, document.value);
  }

  entity(
    type: string,
    collection: string,
    id: string,
  ): StateEntity | undefined {
    return this.#entities.get(entityTarget(type, collection, id));
  }

  members(type: string, collection: string): StateEntity[] {
    return (
      this.#collections.get(collectionTarget(type, collection)) ?? []
    ).map((key) => this.#entities.get(key)!);
  }

  ofType(type: string): StateEntity[] {
    return [...this.#entities.values()].filter(
      (entity) => entity.type === type,
    );
  }

  /** Replace an entity in place, or add it at `index` of its collection (the end when omitted). */
  put(entity: StateEntity, index?: number): void {
    const key = entityTarget(entity.type, entity.collection, entity.id);
    const known = this.#entities.has(key);
    this.#entities.set(key, entity);
    if (known) return;
    const collection = collectionTarget(entity.type, entity.collection);
    const order = this.#collections.get(collection) ?? [];
    order.splice(index ?? order.length, 0, key);
    this.#collections.set(collection, order);
  }

  remove(entity: StateEntity): void {
    const key = entityTarget(entity.type, entity.collection, entity.id);
    this.#entities.delete(key);
    const collection = collectionTarget(entity.type, entity.collection);
    const order = this.#collections.get(collection) ?? [];
    this.#collections.set(
      collection,
      order.filter((member) => member !== key),
    );
  }

  /** Place created entities again as a create under another insert rule would have. */
  reinsert(
    type: string,
    collection: string,
    entities: readonly StateEntity[],
    rule: InsertRule,
  ): void {
    for (const entity of entities) this.remove(entity);
    for (const entity of entities) {
      const order = this.members(type, collection).map(
        (member) => member.fields,
      );
      this.put(entity, insertIndex(rule, order, entity.fields));
    }
  }

  document(tool: string): JsonValue | undefined {
    return this.#documents.get(tool);
  }

  setDocument(tool: string, value: JsonValue): void {
    this.#documents.set(tool, value);
  }
}

/** An item read status that says the entity does not exist: 400, 404 or 410, as applications answer a missing id. */
export const isAbsence = (status: number | null): boolean =>
  status === 400 || status === 404 || status === 410;

/** A 2xx record: the only status whose response shows what a request did. */
export const succeeded = (record: StateRecordFacts): boolean =>
  record.status !== null && record.status >= 200 && record.status < 300;

/** Hand a base recording's body and a read's body to `use` together, parsing a recording once when both are the same. */
export const withBodies = <T>(
  withBody: <U>(ordinal: number, use: (body: JsonValue | undefined) => U) => U,
  ordinals: { readonly base: number; readonly read: number },
  use: (base: JsonValue | undefined, body: JsonValue | undefined) => T,
): T => {
  const { base, read } = ordinals;
  return base === read
    ? withBody(read, (body) => use(body, body))
    : withBody(base, (served) => withBody(read, (body) => use(served, body)));
};

/** A check's outcome and the targets it covered. */
export interface CheckOutcome {
  readonly pass: boolean;
  readonly targets: readonly string[];
  /** Entities the recording, or the served base of a recorded-membership list, lists that the state does not hold, by target. */
  readonly unheld: readonly string[];
}

/** What a check compares: the read's recorded body and the served base recording it would answer on. */
interface ReadBodies {
  readonly body: JsonValue | undefined;
  /** The recording whose envelope the served answer keeps: an item view's envelope, a list line's latest init recording. */
  readonly base: JsonValue | undefined;
  readonly volatile: ReadonlySet<string>;
}

/** An item read: the answer the held entity renders into the served envelope must equal the recording; a recorded 404 or 410 agrees with none held. */
/**
 * The entity an item read names, resolved as serving resolves an item call: its collection and id as written, else a
 * held collection whose path matches once percent-decoded and an id tried decoded, then as written.
 */
export const itemTarget = (
  state: SimulatedState,
  type: string,
  record: Pick<StateRecordFacts, "path">,
): { readonly collection: string; readonly id: string } => {
  const collection = collectionPathOf(record, true);
  const id = lastSegmentValue(record.path);
  if (state.entity(type, collection, id) !== undefined)
    return { collection, id };
  const read = segmentsOf(collection);
  const ids = [decodedSegment(id), id];
  for (const candidate of ids)
    for (const entity of state.ofType(type)) {
      const held = segmentsOf(entity.collection);
      if (
        entity.id === candidate &&
        held.length === read.length &&
        held.every(
          (segment, index) =>
            segment === read[index] || decodedSegment(segment) === read[index],
        )
      )
        return { collection: entity.collection, id: entity.id };
    }
  return { collection, id };
};

export const checkItemRead = (
  state: SimulatedState,
  view: StateItemView,
  record: StateRecordFacts,
  check: ReadBodies,
): CheckOutcome | undefined => {
  const { collection, id } = itemTarget(state, view.type, record);
  const entity = state.entity(view.type, collection, id);
  const targets = [entityTarget(view.type, collection, id)];
  if (isAbsence(record.status) || (succeeded(record) && check.body === null))
    return { pass: entity === undefined, targets, unheld: [] };
  if (!succeeded(record) || check.base === undefined) return undefined;
  const object =
    check.body === undefined ? undefined : at(check.body, view.pointer);
  // A usable body that no longer holds the entity is not what serving answers for one it holds.
  if (!isObject(object))
    return check.body === undefined || entity === undefined
      ? undefined
      : { pass: false, targets, unheld: [] };
  if (entity === undefined) return { pass: false, targets, unheld: targets };
  // Serving refuses an entity lacking a field every recording carried, so no read can confirm one.
  if (missingRequiredFields(entity, view, check.volatile).length > 0)
    return { pass: false, targets, unheld: [] };
  const shown = renderStateEntity(entity, view, check.volatile, object);
  return {
    pass: same(replaceAt(check.base, view.pointer, shown), check.body),
    targets,
    unheld: [],
  };
};

/** A list read's bodies with the listed items of the read and of its served base. */
interface ListBodies {
  readonly body: JsonValue;
  readonly base: JsonValue;
  readonly items: readonly JsonObject[];
  readonly baseItems: readonly JsonObject[];
  readonly idField: string;
  readonly volatile: ReadonlySet<string>;
  /** The collection serving lists: the answering line's. */
  readonly collection: string;
}

/** The served list rendered from the base with `members`, compared with the read; volatile fields take the read's values. */
const listCheck = (
  view: StateListView,
  check: ListBodies,
  members: readonly StateEntity[],
  /** The matches a whole or query answer counts; undefined for recorded members, whose totals stay as recorded. */
  total: number | undefined,
): boolean => {
  if (
    members.some(
      (entity) =>
        missingRequiredFields(entity, view, check.volatile).length > 0,
    )
  )
    return false;
  const observed = new Map(
    check.items.map((item) => [scalarText(item[check.idField]) ?? "", item]),
  );
  const rendered = members.map((entity) =>
    renderStateEntity(entity, view, check.volatile, observed.get(entity.id)),
  );
  const answer =
    view.query === undefined || total === undefined
      ? renderStateList(view, check.base, rendered)
      : renderQueryList(
          { ...view, query: view.query },
          check.base,
          rendered,
          total,
        );
  return same(answer, check.body);
};

/** The base line's and the read's listed entities by target: those the state holds, and those it no longer does. */
const listedTargets = (
  state: SimulatedState,
  view: StateListView,
  check: ListBodies,
): { readonly targets: string[]; readonly unheld: string[] } => {
  const targets: string[] = [];
  const unheld: string[] = [];
  const ids = [...check.baseItems, ...check.items].map(
    (item) => scalarText(item[check.idField]) ?? "",
  );
  for (const id of new Set(ids))
    (state.entity(view.type, check.collection, id) === undefined
      ? unheld
      : targets
    ).push(entityTarget(view.type, check.collection, id));
  return { targets, unheld };
};

/**
 * A list read on a line the query answers: the query's matches in the state, in its order and page. Only a line whose
 * parameters all sort or page, and that shows every match, covers the collection; any other covers the entities it lists.
 */
const checkQueryList = (
  state: SimulatedState,
  view: StateListView,
  check: ListBodies,
  values: ReadonlyMap<string, string>,
): CheckOutcome | undefined => {
  const { collection } = check;
  const result = answerQuery(
    view.query!,
    values,
    state.members(view.type, collection),
  );
  if (result === undefined) return undefined;
  return {
    pass: listCheck(view, check, result.page, result.total),
    targets: [
      ...(result.whole ? [collectionTarget(view.type, collection)] : []),
      ...result.page.map((entity) =>
        entityTarget(view.type, collection, entity.id),
      ),
    ],
    // What the base line or the read listed that the state no longer holds: the read shows whether it went.
    unheld: listedTargets(state, view, check).unheld,
  };
};

/** A list read of every entity of a collection: membership, order, fields and counters must render from the state. */
const checkAllList = (
  state: SimulatedState,
  view: StateListView,
  check: ListBodies,
): CheckOutcome => {
  const { collection } = check;
  const members = state.members(view.type, collection);
  const held = new Set(members.map((entity) => entity.id));
  return {
    pass: listCheck(view, check, members, members.length),
    targets: [
      collectionTarget(view.type, collection),
      ...members.map((entity) =>
        entityTarget(view.type, collection, entity.id),
      ),
    ],
    unheld: check.items
      .map((item) => scalarText(item[check.idField]) ?? "")
      .filter((id) => !held.has(id))
      .map((id) => entityTarget(view.type, collection, id)),
  };
};

/** A list read of recorded members: the served list holds the base's members the state still holds, so a member it dropped or never listed fails. */
const checkRecordedList = (
  state: SimulatedState,
  view: StateListView,
  check: ListBodies,
): CheckOutcome => {
  const { collection } = check;
  const idOf = (item: JsonObject) => scalarText(item[check.idField]) ?? "";
  const members = check.baseItems.flatMap((item) => {
    const entity = state.entity(view.type, collection, idOf(item));
    return entity === undefined ? [] : [entity];
  });
  return {
    pass: listCheck(view, check, members, undefined),
    ...listedTargets(state, view, check),
  };
};

/** A list read on a checked line, compared with the answer the served environment renders on that line's base recording from the collection it names: every entity when that line lists them all. */
export const checkListRead = (
  state: SimulatedState,
  view: StateListView,
  record: StateRecordFacts,
  check: ReadBodies & {
    readonly idField: string;
    readonly collection: string;
    /** The checked line serving answers the read on. */
    readonly line: ServedLine;
  },
): CheckOutcome | undefined => {
  if (!succeeded(record)) return undefined;
  const { line } = check;
  // The line lists every entity of its collection, or its query selects them.
  const query =
    line.queried === true || view.query?.record_ordinals.includes(line.ordinal)
      ? queryValues(record.query)
      : undefined;
  const all = query === undefined && listsAll(view, line.ordinal);
  // Serving answers a page too small for the collection from its recording, so such a read checks nothing.
  const size = pageSize(record.query);
  if (
    all &&
    size !== undefined &&
    state.members(view.type, check.collection).length > size
  )
    return undefined;
  const { body, base } = check;
  const baseItems =
    base === undefined ? undefined : listItems(base, view.pointer);
  if (body === undefined || base === undefined || baseItems === undefined)
    return undefined;
  // A usable body that no longer holds the list is not what serving answers on this line.
  const items = listItems(body, view.pointer);
  // A line the read did not name keeps its own call's envelope, such as a link naming that call's values, which no write changes.
  const envelope = line.named || items === undefined ? base : body;
  const bodies = {
    ...check,
    body,
    base: envelope,
    items: items ?? [],
    baseItems,
  };
  const outcome =
    query !== undefined
      ? checkQueryList(state, view, bodies, query)
      : all
        ? checkAllList(state, view, bodies)
        : checkRecordedList(state, view, bodies);
  if (outcome === undefined) return undefined;
  return items === undefined ? { ...outcome, pass: false } : outcome;
};

/** A document read on its checked line must equal the held document. */
export const checkDocumentRead = (
  state: SimulatedState,
  tool: string,
  record: StateRecordFacts,
  body: JsonValue | undefined,
): CheckOutcome | undefined => {
  if (!succeeded(record)) return undefined;
  const value = state.document(tool);
  if (body === undefined || value === undefined) return undefined;
  return {
    pass: same(value, body),
    targets: [documentTarget(tool)],
    unheld: [],
  };
};

/**
 * Check, field by field, the writes that changed an entity an unmodelled write also changed:
 * each write's own fields must show as the state holds them. A create wrote every field, so it
 * cannot be told apart from the unmodelled change and is not checked.
 */
export const writtenFieldChecks = (
  entity: StateEntity,
  view: StateItemView,
  observed: JsonObject,
  check: {
    readonly volatile: ReadonlySet<string>;
    readonly writes: ReadonlyMap<string, readonly string[] | null>;
  },
): Map<string, boolean> => {
  const shown = renderStateEntity(entity, view, check.volatile, observed);
  const outcomes = new Map<string, boolean>();
  for (const [tool, fields] of check.writes) {
    const compared = (fields ?? []).filter(
      (field) => Object.hasOwn(observed, field) || Object.hasOwn(shown, field),
    );
    if (fields === null || compared.length === 0) continue;
    outcomes.set(
      tool,
      compared.every((field) => same(shown[field], observed[field])),
    );
  }
  return outcomes;
};
