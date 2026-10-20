import type { JsonValue } from "../jsonValue.js";
import {
  compareUnicodeCodePoints as compare,
  compositeKey,
} from "../unicodeCodePointOrder.js";
import {
  IDENTITY_NAMES,
  at,
  collectionPathOf,
  identifies,
  identityCandidates,
  isObject,
  isParam,
  isQueryPost,
  isStateWrite,
  jsonBytes,
  hasPrototypeKey,
  lastSegmentValue,
  listItems,
  normalizedPath,
  locateItem,
  locateList,
  rootOf,
  rootsRelated,
  same,
  scalarText,
  segmentsOf,
  apiBaseLengths,
  type ExtractedState,
  type JsonObject,
  type RecordedViewReason,
  type StateBudget,
  type StateDocument,
  type StateEntity,
  type StateRecordFacts,
  type StateTimeline,
  type StateToolFacts,
  type StateType,
  type StateView,
} from "./environmentStateRules.js";
import { ENTRY_BYTES, textBytes } from "./webNetworkRouteTemplates.js";
import {
  compareObservedEntities,
  mergeObservedEntity,
  type ObservedEntity,
} from "./environmentStateMerge.js";
import {
  checkItemPlan,
  checkListPlan,
  type StateGateContext,
  type StatePlan,
} from "./environmentStateGate.js";

class StateBudgetExhausted extends Error {}

type Candidate = Pick<StatePlan, "tool" | "item" | "type">;

const entityKey = (type: string, collection: string, id: string): string =>
  compositeKey([type, collection, id]);

const requestLine = (record: StateRecordFacts): string =>
  record.path + (record.query ?? "");

/** Derive the init state and render plans from manifest tools and timeline-ordered records. */
export class EnvironmentStateExtraction {
  readonly #tools: readonly StateToolFacts[];
  readonly #timeline: StateTimeline;
  readonly #budget: StateBudget;
  readonly #position: ReadonlyMap<number, number>;
  readonly #byOrdinal: ReadonlyMap<number, StateRecordFacts>;
  readonly #writes: readonly StateRecordFacts[];
  readonly #bases: ReadonlyMap<string, number>;
  readonly #identity = new Map<
    string,
    { readonly field: string; readonly basis: StateType["id_basis"] }
  >();
  readonly #views = new Map<string, StateView>();
  readonly #plans: StatePlan[] = [];
  readonly #entities = new Map<string, ObservedEntity>();
  readonly #volatile = new Map<string, Set<string>>();
  readonly #merged = new Map<string, StateEntity>();

  constructor(input: {
    readonly tools: readonly StateToolFacts[];
    readonly records: readonly StateRecordFacts[];
    readonly timeline: StateTimeline;
    readonly budget: StateBudget;
  }) {
    this.#tools = input.tools;
    this.#timeline = input.timeline;
    this.#budget = input.budget;
    this.#position = new Map(
      input.records.map((record, index) => [record.ordinal, index]),
    );
    this.#byOrdinal = new Map(
      input.records.map((record) => [record.ordinal, record]),
    );
    this.#writes = input.records.filter(isStateWrite);
    this.#bases = apiBaseLengths(input.tools.map((tool) => tool.path_template));
  }

  /** The extracted state, or null when the representation budget is exhausted. */
  run(): ExtractedState | null {
    try {
      const candidates = this.#candidates();
      for (const candidate of candidates.filter((entry) => entry.item))
        this.#planItem(candidate);
      for (const candidate of candidates.filter((entry) => !entry.item))
        this.#planList(candidate);
      for (const plan of this.#plans) this.#observePlan(plan);
      this.#merge();
      const gate = this.#gateContext();
      for (const plan of this.#plans)
        this.#views.set(
          plan.tool.name,
          plan.item ? checkItemPlan(gate, plan) : checkListPlan(gate, plan),
        );
      return this.#result(this.#documents(candidates));
    } catch (cause: unknown) {
      if (cause instanceof StateBudgetExhausted) return null;
      throw cause;
    }
  }

  #retain(bytes: number): void {
    if (!this.#budget.retain(bytes)) throw new StateBudgetExhausted();
  }

  /** Parse one body and hand it to `use` before its temporary work is dropped; unusable bodies arrive undefined. */
  #withBody<T>(ordinal: number, use: (body: JsonValue | undefined) => T): T {
    const parsed = this.#budget.body(ordinal);
    if (parsed === null) throw new StateBudgetExhausted();
    try {
      return use(
        parsed.kind === "json" && !hasPrototypeKey(parsed.value)
          ? parsed.value
          : undefined,
      );
    } finally {
      this.#budget.release();
    }
  }

  #recorded(tool: StateToolFacts, reason: RecordedViewReason): void {
    this.#views.set(tool.name, { tool: tool.name, shape: "recorded", reason });
  }

  /** GET tools may render from state; query POSTs stay recorded. */
  #candidates(): Candidate[] {
    const candidates: Candidate[] = [];
    for (const tool of this.#tools) {
      if (isQueryPost(tool.method, tool.path_template))
        this.#recorded(tool, "query-body");
      if (tool.method !== "GET") continue;
      const segments = segmentsOf(tool.path_template);
      const item = segments.length > 0 && isParam(segments.at(-1)!);
      candidates.push({
        tool,
        item,
        type: item
          ? `/${segments.slice(0, -1).join("/")}`
          : normalizedPath(tool.path_template),
      });
    }
    return candidates;
  }

  /** The first write whose root relates to the template's bounds its init recordings. */
  #initLimit(template: string): StateRecordFacts | undefined {
    const root = rootOf(template, this.#bases);
    return this.#writes.find((write) =>
      rootsRelated(root, rootOf(write.path, this.#bases)),
    );
  }

  /** Successful recordings that finished before the first related write began. */
  #initRecordings(tool: StateToolFacts, template: string): StateRecordFacts[] {
    const limit = this.#initLimit(template);
    const before = (record: StateRecordFacts): boolean =>
      limit === undefined ||
      (this.#position.get(record.ordinal)! <
        this.#position.get(limit.ordinal)! &&
        (this.#timeline === "record-order" || record.end <= limit.start));
    return tool.record_ordinals
      .map((ordinal) => this.#byOrdinal.get(ordinal))
      .filter(
        (record): record is StateRecordFacts =>
          record !== undefined &&
          record.status !== null &&
          record.status >= 200 &&
          record.status < 300 &&
          before(record),
      )
      .sort(
        (left, right) =>
          this.#position.get(left.ordinal)! -
          this.#position.get(right.ordinal)!,
      );
  }

  #latestPerLine(recordings: readonly StateRecordFacts[]): StateRecordFacts[] {
    const latest = new Map<string, StateRecordFacts>();
    for (const record of recordings) {
      latest.delete(requestLine(record));
      latest.set(requestLine(record), record);
    }
    return [...latest.values()];
  }

  /** A candidate's initial recordings, or undefined after recording that it has none. */
  #initRecordingsOf(candidate: Candidate): StateRecordFacts[] | undefined {
    const recordings = this.#initRecordings(candidate.tool, candidate.type);
    if (recordings.length > 0) return recordings;
    this.#recorded(candidate.tool, "no-init-recording");
    return undefined;
  }

  #addPlan(
    candidate: Candidate,
    pointer: string,
    recordings: readonly StateRecordFacts[],
  ): void {
    this.#plans.push({
      ...candidate,
      pointer,
      recordings,
      latest: this.#latestPerLine(recordings),
    });
  }

  /** Item tools prove a type's identity field by the path value their bodies repeat. */
  #planItem(candidate: Candidate): void {
    const { tool, type } = candidate;
    const recordings = this.#initRecordingsOf(candidate);
    if (recordings === undefined) return;
    let pointer: string | undefined;
    let keys: string[] | undefined;
    for (const record of recordings) {
      const located = this.#withBody(record.ordinal, (body) =>
        body === undefined
          ? null
          : locateItem(body, lastSegmentValue(record.path)),
      );
      if (located === null) {
        this.#recorded(tool, "body-unusable");
        return;
      }
      if (
        located === undefined ||
        (pointer ?? located.pointer) !== located.pointer
      ) {
        this.#recorded(tool, "no-identity");
        return;
      }
      pointer = located.pointer;
      keys = (keys ?? located.keys).filter((key) => located.keys.includes(key));
    }
    const field =
      IDENTITY_NAMES.find((name) => keys?.includes(name) === true) ?? keys?.[0];
    const known = this.#identity.get(type);
    if (
      field === undefined ||
      pointer === undefined ||
      (known !== undefined && known.field !== field)
    ) {
      this.#recorded(tool, "no-identity");
      return;
    }
    this.#identity.set(type, { field, basis: "path-parameter" });
    this.#addPlan(candidate, pointer, recordings);
  }

  /**
   * List tools use the proved field, else the first identity candidate every non-empty recording's
   * items share; a suffix-named field must also show distinct values across two items of one
   * recording. Reads without a list or identity are left to documents.
   */
  #planList(candidate: Candidate): void {
    const { tool, type } = candidate;
    const recordings = this.#initRecordingsOf(candidate);
    if (recordings === undefined) return;
    const proved = this.#identity.get(type)?.field;
    const fieldsOf = (items: readonly JsonObject[]): string[] =>
      proved === undefined
        ? identityCandidates(items)
        : identifies(items, proved)
          ? [proved]
          : [];
    let pointer: string | undefined;
    let names: readonly string[] | undefined;
    // A single listed item is distinct from nothing, so it shows no field distinct.
    const shown = new Set<string>();
    for (const record of recordings) {
      const found = this.#withBody(record.ordinal, (body) => {
        if (body === undefined) return null;
        const located = pointer ?? locateList(body, proved);
        const items =
          located === undefined ? undefined : listItems(body, located);
        if (items === undefined) return undefined;
        pointer = located;
        // An empty list constrains no field.
        return items.length === 0
          ? true
          : { fields: fieldsOf(items), several: items.length > 1 };
      });
      if (found === undefined) return;
      if (found === null) {
        this.#recorded(tool, "body-unusable");
        return;
      }
      if (found === true) continue;
      names = (names ?? found.fields).filter((name) =>
        found.fields.includes(name),
      );
      if (found.several) for (const name of found.fields) shown.add(name);
    }
    const field = (
      names ?? (proved === undefined ? IDENTITY_NAMES : [proved])
    ).find(
      (name) =>
        name === proved || IDENTITY_NAMES.includes(name) || shown.has(name),
    );
    if (field === undefined || pointer === undefined) return;
    if (!this.#identity.has(type))
      this.#identity.set(type, { field, basis: "field-name" });
    this.#addPlan(candidate, pointer, recordings);
  }

  #observePlan(plan: StatePlan): void {
    for (const record of plan.recordings)
      this.#withBody(record.ordinal, (body) => {
        const located = body === undefined ? undefined : at(body, plan.pointer);
        const objects = plan.item
          ? isObject(located)
            ? [located]
            : []
          : Array.isArray(located)
            ? located.filter(isObject)
            : [];
        objects.forEach((object, index) =>
          this.#observe(plan, record, object, index),
        );
      });
  }

  /** Record one observed entity object; a value that changes between one tool's own observations is volatile. */
  #observe(
    plan: StatePlan,
    record: StateRecordFacts,
    object: JsonObject,
    index: number,
  ): void {
    const field = this.#identity.get(plan.type)!.field;
    const id = scalarText(object[field]);
    if (id === undefined) return;
    const collection = collectionPathOf(record, plan.item);
    const key = entityKey(plan.type, collection, id);
    const order: [number, number] = [
      this.#position.get(record.ordinal)!,
      index,
    ];
    let entity = this.#entities.get(key);
    if (entity === undefined) {
      this.#retain(ENTRY_BYTES * 4 + textBytes(key.length));
      entity = { type: plan.type, collection, id, order, observations: [] };
      this.#entities.set(key, entity);
    } else if (
      order[0] < entity.order[0] ||
      (order[0] === entity.order[0] && order[1] < entity.order[1])
    )
      // Plans observe items before lists, so the earliest sighting may arrive later.
      entity.order = order;
    const earlier = entity.observations.findLast(
      (observation) => observation.tool === plan.tool.name,
    );
    for (const name of Object.keys(object))
      if (
        earlier !== undefined &&
        Object.hasOwn(earlier.object, name) &&
        !same(earlier.object[name], object[name])
      ) {
        const fields = this.#volatile.get(plan.type) ?? new Set<string>();
        this.#volatile.set(plan.type, fields.add(name));
      }
    this.#retain(ENTRY_BYTES + jsonBytes(object));
    entity.observations.push({
      position: this.#position.get(record.ordinal)!,
      ordinal: record.ordinal,
      tool: plan.tool.name,
      item: plan.item,
      object,
    });
  }

  #merge(): void {
    for (const entity of [...this.#entities.values()].sort(
      compareObservedEntities,
    ))
      this.#merged.set(
        entityKey(entity.type, entity.collection, entity.id),
        mergeObservedEntity(entity),
      );
  }

  #gateContext(): StateGateContext {
    return {
      withBody: (ordinal, use) => this.#withBody(ordinal, use),
      retain: (bytes) => this.#retain(bytes),
      entity: (type, collection, id) =>
        this.#merged.get(entityKey(type, collection, id)),
      inCollection: (type, collection) => this.#inCollection(type, collection),
      volatileOf: (type) => this.#volatileOf(type),
      idField: (type) => this.#identity.get(type)!.field,
    };
  }

  #volatileOf(type: string): ReadonlySet<string> {
    return this.#volatile.get(type) ?? new Set<string>();
  }

  #inCollection(type: string, collection: string): StateEntity[] {
    return [...this.#merged.values()].filter(
      (entity) => entity.type === type && entity.collection === collection,
    );
  }

  /** A list tool without a plan or recorded reason holds one document value: its latest init recording, under one request line. */
  #documents(candidates: readonly Candidate[]): StateDocument[] {
    const documents: StateDocument[] = [];
    for (const { tool, item } of candidates) {
      if (item || this.#views.has(tool.name)) continue;
      const latest = this.#latestPerLine(
        this.#initRecordings(tool, tool.path_template),
      );
      if (latest.length !== 1) {
        const paths = new Set(latest.map((record) => record.path));
        this.#recorded(
          tool,
          latest.length === 0
            ? "no-init-recording"
            : paths.size > 1
              ? "path-varies"
              : "query-varies",
        );
        continue;
      }
      const record = latest[0]!;
      const value = this.#withBody(record.ordinal, (body) => body);
      if (value === undefined) {
        this.#recorded(tool, "body-unusable");
        continue;
      }
      this.#retain(
        ENTRY_BYTES + jsonBytes(value) + textBytes(record.path.length),
      );
      documents.push({
        tool: tool.name,
        path: record.path,
        value,
        record_ordinal: record.ordinal,
      });
      this.#views.set(tool.name, {
        tool: tool.name,
        shape: "document",
        checked_record_ordinals: [record.ordinal],
      });
    }
    return documents.sort((left, right) => compare(left.tool, right.tool));
  }

  /** Types and entities that at least one state-backed view renders; view values only for those views. */
  #result(documents: StateDocument[]): ExtractedState {
    const backed = new Set(
      [...this.#views.values()].flatMap((view) =>
        view.shape === "item" || view.shape === "list" ? [view.tool] : [],
      ),
    );
    const types = [...this.#identity.entries()]
      .filter(([type]) =>
        this.#plans.some(
          (plan) => plan.type === type && backed.has(plan.tool.name),
        ),
      )
      .map(([type, { field, basis }]): StateType => ({
        collection_template: type,
        id_field: field,
        id_basis: basis,
        init_before_ordinal: this.#initLimit(type)?.ordinal ?? null,
        volatile_fields: [...this.#volatileOf(type)].sort(compare),
      }))
      .sort((left, right) =>
        compare(left.collection_template, right.collection_template),
      );
    const typed = new Set(types.map((type) => type.collection_template));
    return {
      types,
      entities: [...this.#merged.values()]
        .filter((entity) => typed.has(entity.type))
        .map((entity) => ({
          ...entity,
          view_fields: entity.view_fields.filter((view) =>
            backed.has(view.tool),
          ),
        })),
      documents,
      views: this.#tools.flatMap((tool) => {
        const view = this.#views.get(tool.name);
        return view === undefined ? [] : [view];
      }),
    };
  }
}
