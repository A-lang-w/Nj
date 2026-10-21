import type { JsonValue } from "../jsonValue.js";
import {
  at,
  isObject,
  lastSegmentValue,
  listItems,
  scalarText,
  type JsonObject,
  type StateItemView,
  type StateListView,
  type StateRecordFacts,
  type StateView,
} from "./environmentStateRules.js";
import {
  checkItemRead,
  checkListRead,
  succeeded,
  type CheckOutcome,
  type ReadBodies,
  type SimulatedState,
} from "./environmentStateWriteChecks.js";

/**
 * Fields a view's recordings always carried that a later successful read shows the application
 * leaves out of an entity, as APIs that omit empty or false members do: no entity must carry them.
 */
export class OmittedFields {
  readonly #omitted = new Map<string, Set<string>>();

  constructor(private readonly retain: (bytes: number) => void) {}

  /** Check an item or list read with the fields reads showed omitted, this one's included, no longer required. */
  check(
    state: SimulatedState,
    view: StateItemView | StateListView,
    record: StateRecordFacts,
    read: ReadBodies & {
      readonly idField: string;
      readonly collection: string;
    },
  ): CheckOutcome | undefined {
    const relaxed = this.#relax(view, record, read);
    return relaxed.shape === "item"
      ? checkItemRead(state, relaxed, record, read)
      : checkListRead(state, relaxed, record, read);
  }

  /** Note the required fields the read's entities lack, and the view without every field noted so far. */
  #relax<View extends StateItemView | StateListView>(
    view: View,
    record: StateRecordFacts,
    read: { readonly body: JsonValue | undefined; readonly idField: string },
  ): View {
    if (succeeded(record) && read.body !== undefined)
      for (const entity of readEntities(view, record, read))
        for (const field of view.required_fields)
          if (!Object.hasOwn(entity, field)) this.#note(view.tool, field);
    return relaxed(view, this.#omitted.get(view.tool));
  }

  /** The views with the fields reads showed omitted no longer required. */
  views(views: readonly StateView[]): StateView[] {
    return views.map((view) =>
      view.shape === "item" || view.shape === "list"
        ? relaxed(view, this.#omitted.get(view.tool))
        : view,
    );
  }

  #note(tool: string, field: string): void {
    let fields = this.#omitted.get(tool);
    if (fields === undefined) {
      fields = new Set();
      this.#omitted.set(tool, fields);
    }
    if (!fields.has(field)) {
      this.retain(64 + field.length * 2);
      fields.add(field);
    }
  }
}

/** The entities a read shows: an item read's object naming the path's id, a list read's items with an id. */
const readEntities = (
  view: StateItemView | StateListView,
  record: StateRecordFacts,
  read: { readonly body: JsonValue | undefined; readonly idField: string },
): JsonObject[] => {
  if (view.shape === "item") {
    const object = at(read.body!, view.pointer);
    return isObject(object) &&
      scalarText(object[read.idField]) === lastSegmentValue(record.path)
      ? [object]
      : [];
  }
  return (listItems(read.body!, view.pointer) ?? []).filter(
    (item) => scalarText(item[read.idField]) !== undefined,
  );
};

const relaxed = <View extends StateItemView | StateListView>(
  view: View,
  omitted: ReadonlySet<string> | undefined,
): View =>
  omitted === undefined
    ? view
    : {
        ...view,
        required_fields: view.required_fields.filter(
          (field) => !omitted.has(field),
        ),
      };
