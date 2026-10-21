import {
  at,
  isObject,
  lastSegmentValue,
  listItems,
  projectsFields,
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
 * Fields a type's recordings always carried that a later successful whole read shows the
 * application leaves out of an entity the state holds, as APIs that omit empty or false members
 * do: no entity of the type must carry them, in any of its views.
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
    const relaxed = this.#relax(state, view, record, read);
    return relaxed.shape === "item"
      ? checkItemRead(state, relaxed, record, read)
      : checkListRead(state, relaxed, record, read);
  }

  /** Note the required fields the read's held entities lack, and the view without every field noted so far for its type. */
  #relax<View extends StateItemView | StateListView>(
    state: SimulatedState,
    view: View,
    record: StateRecordFacts,
    read: Pick<ReadBodies, "body"> & {
      readonly idField: string;
      readonly collection: string;
    },
  ): View {
    if (
      succeeded(record) &&
      read.body !== undefined &&
      !projectsFields(record.query)
    )
      for (const entity of heldEntities(state, view, record, read))
        for (const field of view.required_fields)
          if (!Object.hasOwn(entity, field)) this.#note(view.type, field);
    return relaxed(view, this.#omitted.get(view.type));
  }

  /** The views with the fields reads showed omitted no longer required. */
  views(views: readonly StateView[]): StateView[] {
    return views.map((view) =>
      view.shape === "item" || view.shape === "list"
        ? relaxed(view, this.#omitted.get(view.type))
        : view,
    );
  }

  #note(type: string, field: string): void {
    let fields = this.#omitted.get(type);
    if (fields === undefined) {
      fields = new Set();
      this.#omitted.set(type, fields);
    }
    if (!fields.has(field)) {
      this.retain(64 + field.length * 2);
      fields.add(field);
    }
  }
}

/** The entities a read shows that the state holds: an item read's object naming the path's id, a list read's items. */
const heldEntities = (
  state: SimulatedState,
  view: StateItemView | StateListView,
  record: StateRecordFacts,
  read: Pick<ReadBodies, "body"> & {
    readonly idField: string;
    readonly collection: string;
  },
): JsonObject[] => {
  const object = view.shape === "item" ? at(read.body!, view.pointer) : null;
  const shown =
    view.shape === "list"
      ? (listItems(read.body!, view.pointer) ?? [])
      : isObject(object) &&
          scalarText(object[read.idField]) === lastSegmentValue(record.path)
        ? [object]
        : [];
  return shown.filter((entity) => {
    const id = scalarText(entity[read.idField]);
    return (
      id !== undefined &&
      state.entity(view.type, read.collection, id) !== undefined
    );
  });
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
