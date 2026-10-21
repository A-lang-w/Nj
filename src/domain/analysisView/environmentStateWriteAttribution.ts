/** Modelled writes per target since its last check, with the fields each wrote (null: all). */
export type TouchedTargets = Map<string, Map<string, readonly string[] | null>>;

/** Per target, the earliest modelled write since its last check and when the latest of them ended. */
export type PendingTargets = Map<string, { since: number; until: number }>;

/** Record a modelled write on a target: the fields it wrote (undefined: all), when it began and when it ended. */
export const touchTarget = (
  touched: TouchedTargets,
  pending: PendingTargets,
  target: string,
  write: {
    readonly index: number;
    readonly tool: string;
    readonly end: number;
    readonly fields: readonly string[] | undefined;
  },
): void => {
  const since = pending.get(target);
  pending.set(target, {
    since: since?.since ?? write.index,
    until: Math.max(since?.until ?? -Infinity, write.end),
  });
  const tools = touched.get(target) ?? new Map();
  const before = tools.get(write.tool);
  tools.set(
    write.tool,
    write.fields === undefined || before === null
      ? null
      : [...new Set([...(before ?? []), ...write.fields])],
  );
  touched.set(target, tools);
};

/** The fields of a write's effect on an entity no later write has overwritten: all of them for a create or delete (null). */
type ChangedFields = readonly string[] | null;

/** What a later write overwrites: the whole entity, the fields it sets, or every field (a recorded outcome). */
interface Overwrite {
  readonly whole: boolean;
  readonly fields: ReadonlySet<string> | "all";
}

/** What an earlier effect keeps after a write: nothing once every field it holds is overwritten; an update leaves a create's or delete's whole effect. */
const remaining = (
  claim: ChangedFields,
  write: Overwrite,
): ChangedFields | undefined => {
  if (write.whole) return undefined;
  if (claim === null) return null;
  const { fields } = write;
  if (fields === "all") return undefined;
  const left = claim.filter((field) => !fields.has(field));
  return left.length > 0 ? left : undefined;
};

/** Add a write's changed fields under a key: all of them once any write there changed the whole entity. */
const record = (
  map: Map<string, ChangedFields>,
  key: string,
  whole: boolean,
  changed: readonly string[],
): Map<string, ChangedFields> => {
  const before = map.get(key);
  return map.set(
    key,
    whole || before === null
      ? null
      : [...new Set([...(before ?? []), ...changed])],
  );
};

/**
 * What each write changed since the targets it touched were last checked, less what later writes overwrote, so a
 * write whose effect is gone drops out: from the entity's target, and from its collection's once no entity it changed
 * there keeps any of it.
 */
export class WriteEffects {
  /** Per entity target, the fields each tool changed there. */
  readonly #changed = new Map<string, Map<string, ChangedFields>>();
  /** Per collection target, the entities each tool's claim there rests on, with the fields it changed on each. */
  readonly #members = new Map<
    string,
    Map<string, Map<string, ChangedFields>>
  >();

  /** Forget a checked target's writes, as the touched targets do. */
  checked(key: string): void {
    this.#changed.delete(key);
    this.#members.delete(key);
  }

  /** A read showed the entity absent: no write's effect on it remains, so a write left with no entity drops from the collection. */
  removed(touched: TouchedTargets, entity: string, collection: string): void {
    this.#changed.delete(entity);
    const byTool = this.#members.get(collection);
    if (byTool === undefined) return;
    for (const [tool, entities] of byTool) {
      if (!entities.delete(entity) || entities.size > 0) continue;
      byTool.delete(tool);
      touched.get(collection)?.delete(tool);
    }
  }

  /** A write's effect replaces what earlier writes left of theirs, then joins them. */
  supersede(
    touched: TouchedTargets,
    writer: string,
    effect: {
      readonly targets: readonly string[];
      readonly fields?: readonly string[];
      readonly changed?: {
        readonly fields: readonly string[];
        readonly accumulated: readonly string[];
      };
    },
  ): void {
    const [entity, collection] = effect.targets as [string, string?];
    const changed = effect.changed?.fields ?? effect.fields ?? [];
    const whole = effect.fields === undefined;
    this.#overwrite(
      touched,
      { entity, collection, writer },
      {
        whole,
        fields: new Set(
          changed.filter(
            (field) => !effect.changed?.accumulated.includes(field),
          ),
        ),
      },
    );
    this.#changed.set(
      entity,
      record(this.#changed.get(entity) ?? new Map(), writer, whole, changed),
    );
    if (collection === undefined) return;
    const byTool = this.#members.get(collection) ?? new Map();
    byTool.set(
      writer,
      record(byTool.get(writer) ?? new Map(), entity, whole, changed),
    );
    this.#members.set(collection, byTool);
  }

  /** A recorded outcome is the entity's new baseline: what earlier writes changed on it is gone, its membership is not. */
  observed(touched: TouchedTargets, targets: readonly string[]): void {
    const [entity, collection] = targets as [string, string?];
    this.#overwrite(
      touched,
      { entity, collection, writer: undefined },
      { whole: false, fields: "all" },
    );
  }

  #overwrite(
    touched: TouchedTargets,
    at: {
      readonly entity: string;
      readonly collection: string | undefined;
      readonly writer: string | undefined;
    },
    write: Overwrite,
  ): void {
    const own = this.#changed.get(at.entity);
    for (const [tool, claim] of own ?? []) {
      const left = tool === at.writer ? claim : remaining(claim, write);
      if (left !== undefined) own!.set(tool, left);
      else {
        own!.delete(tool);
        touched.get(at.entity)?.delete(tool);
      }
    }
    if (at.collection === undefined) return;
    const byTool = this.#members.get(at.collection);
    for (const [tool, entities] of byTool ?? []) {
      const claim = entities.get(at.entity);
      if (tool === at.writer || claim === undefined) continue;
      const left = remaining(claim, write);
      if (left !== undefined) entities.set(at.entity, left);
      else entities.delete(at.entity);
      if (entities.size > 0) continue;
      byTool!.delete(tool);
      touched.get(at.collection)?.delete(tool);
    }
  }
}
