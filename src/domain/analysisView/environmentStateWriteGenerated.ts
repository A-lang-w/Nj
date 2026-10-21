import type { JsonValue } from "../jsonValue.js";
import {
  isObject,
  type JsonObject,
  type StateEntity,
} from "./environmentStateRules.js";
import { isUuid } from "./environmentStateWriteValues.js";

type Pair = readonly [JsonValue, JsonValue];

/** The UUIDs `after` holds where `before` held others, when the two differ in nothing else; undefined otherwise. */
export const renewedUuids = (
  before: JsonValue,
  after: JsonValue,
): Map<string, string> | undefined => {
  const renewed = new Map<string, string>();
  const pending: Pair[] = [[before, after]];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const [was, now] = next;
    if (isUuid(was) && isUuid(now) && was !== now) {
      if ((renewed.get(was) ?? now) !== now) return undefined;
      renewed.set(was, now);
    } else if (Array.isArray(was) && Array.isArray(now)) {
      if (was.length !== now.length) return undefined;
      for (const [index, item] of was.entries())
        pending.push([item, now[index]!]);
    } else if (isObject(was) && isObject(now)) {
      const keys = Object.keys(was);
      if (keys.length !== Object.keys(now).length) return undefined;
      for (const key of keys) {
        if (!Object.hasOwn(now, key)) return undefined;
        pending.push([was[key]!, now[key]!]);
      }
    } else if (was !== now) return undefined;
  }
  // A UUID the value already held is a reference that moved, not a fresh one.
  const held = new Set(renewed.keys());
  return renewed.size > 0 &&
    [...renewed.values()].every((uuid) => !held.has(uuid))
    ? renewed
    : undefined;
};

/** The fields of every entity but the one named. */
export const otherFields = (
  entities: readonly StateEntity[],
  named: { readonly collection: string; readonly id: string },
): JsonObject[] =>
  entities
    .filter(
      (entity) =>
        entity.id !== named.id || entity.collection !== named.collection,
    )
    .map((entity) => entity.fields);
