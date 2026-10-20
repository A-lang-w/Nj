import type {
  StateRecordFacts,
  StateDocument,
  StateEntity,
  StateType,
} from "./environmentStateRules.js";
import { SimulatedState } from "./environmentStateWriteChecks.js";
import { WriteTaint } from "./environmentStateWriteTaint.js";

/** What a session replay starts from: the records with their sessions, and the initial state. */
interface SessionInput {
  readonly records: readonly StateRecordFacts[];
  readonly sessionOf?: (record: StateRecordFacts) => number;
  readonly types: readonly StateType[];
  readonly entities: readonly StateEntity[];
  readonly documents: readonly StateDocument[];
}

/** One recording session's replay: its records, the state its writes change and what its checks have seen; indexes are within the session. */
export class SessionReplay {
  readonly state: SimulatedState;
  readonly taint: WriteTaint;
  /** Modelled writes per target since its last check, with the fields each wrote (null: all). */
  readonly touched = new Map<string, Map<string, readonly string[] | null>>();
  readonly lastCheck = new Map<string, number>();
  /** The earliest modelled write to each target since its last check. */
  readonly touchedSince = new Map<string, number>();
  /** Indexes of writes the gate does not model. */
  readonly unmodelledAt: number[] = [];
  readonly log: {
    readonly index: number;
    readonly tool: string;
    readonly path: string;
  }[] = [];
  /** Entities a create inserted, by target, with the create's tool. */
  readonly inserted = new Map<string, string>();

  constructor(
    readonly records: readonly StateRecordFacts[],
    input: SessionInput,
  ) {
    this.state = new SimulatedState(input.entities, input.documents);
    this.taint = new WriteTaint(
      input.types.map((type) => type.collection_template),
      new Map(
        input.documents.map((document) => [document.tool, document.path]),
      ),
      (type, collection, id) =>
        this.state.entity(type, collection, id) !== undefined,
    );
  }
}

/** The capture's records split into recording sessions, each kept in timeline order. */
export const sessionsOf = (input: SessionInput): StateRecordFacts[][] => {
  const sessions: StateRecordFacts[][] = [];
  let current: number | undefined;
  for (const record of input.records) {
    const session = input.sessionOf?.(record) ?? 0;
    if (session !== current || sessions.length === 0) sessions.push([]);
    current = session;
    sessions.at(-1)!.push(record);
  }
  return sessions;
};
