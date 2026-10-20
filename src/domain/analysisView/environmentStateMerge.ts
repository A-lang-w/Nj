import type { JsonValue } from "../jsonValue.js";
import { compareUnicodeCodePoints as compare } from "../unicodeCodePointOrder.js";
import {
  same,
  type JsonObject,
  type StateEntity,
} from "./environmentStateRules.js";

/** One entity object as one tool recorded it. */
export interface StateObservation {
  readonly position: number;
  readonly ordinal: number;
  readonly tool: string;
  readonly item: boolean;
  readonly object: JsonObject;
}

/** Every init observation of one entity, with where it was first seen. */
export interface ObservedEntity {
  readonly type: string;
  readonly collection: string;
  readonly id: string;
  /** The earliest recorded sighting: timeline position, then position in its list. */
  order: readonly [number, number];
  readonly observations: StateObservation[];
}

/** Collection order: type, collection, then first sighting. */
export const compareObservedEntities = (
  left: ObservedEntity,
  right: ObservedEntity,
): number =>
  compare(left.type, right.type) ||
  compare(left.collection, right.collection) ||
  left.order[0] - right.order[0] ||
  left.order[1] - right.order[1];

/** One entity: item views' latest values win over list views', and a view whose latest values differ keeps them. */
export const mergeObservedEntity = (entity: ObservedEntity): StateEntity => {
  const latest = new Map<string, StateObservation>();
  for (const observation of entity.observations)
    latest.set(observation.tool, observation);
  const fields = new Map<string, JsonValue>();
  const ranked = [...latest.values()].sort(
    (left, right) =>
      Number(left.item) - Number(right.item) || left.position - right.position,
  );
  for (const observation of ranked)
    for (const [name, value] of Object.entries(observation.object))
      fields.set(name, value);
  return {
    type: entity.type,
    collection: entity.collection,
    id: entity.id,
    fields: Object.fromEntries(fields),
    view_fields: [...latest.values()]
      .map((observation) => ({
        tool: observation.tool,
        fields: Object.fromEntries(
          Object.entries(observation.object).filter(
            ([name, value]) => !same(fields.get(name), value),
          ),
        ),
      }))
      .filter((view) => Object.keys(view.fields).length > 0)
      .sort((left, right) => compare(left.tool, right.tool)),
    record_ordinals: [
      ...new Set(entity.observations.map((observation) => observation.ordinal)),
    ],
  };
};
