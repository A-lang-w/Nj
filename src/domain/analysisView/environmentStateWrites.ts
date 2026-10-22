import type { ExtractedState } from "./environmentStateRules.js";
import { EnvironmentStateWriteSimulation } from "./EnvironmentStateWriteSimulation.js";
import type { WriteSimulationInput } from "./environmentStateWriteEffects.js";

/** The instant a served clock starts from: the end of the last timed record, to the next whole second. */
const clockStart = (
  records: WriteSimulationInput["records"],
  timed: boolean,
): string | null => {
  if (!timed || records.length === 0) return null;
  const end = records.reduce(
    (latest, record) => Math.max(latest, record.end),
    Number.NEGATIVE_INFINITY,
  );
  if (!Number.isFinite(end)) return null;
  const start = new Date(Math.ceil(end / 1000) * 1000);
  // A recorded time past the range a date can hold gives no served clock.
  return Number.isNaN(start.getTime()) ? null : start.toISOString();
};

/**
 * The write plans a capture's own timeline confirms against an extracted state, the served clock's
 * start, and the views without the fields reads showed the application leaves out.
 */
export const extractWrites = (
  state: Pick<ExtractedState, "views" | "types" | "entities" | "documents">,
  input: Omit<
    WriteSimulationInput,
    "views" | "types" | "entities" | "documents"
  >,
): Pick<ExtractedState, "writes" | "write_clock" | "views"> => {
  const simulation = new EnvironmentStateWriteSimulation({
    ...input,
    views: new Map(state.views.map((view) => [view.tool, view])),
    types: state.types,
    entities: state.entities,
    documents: state.documents,
  });
  const writes = simulation.run();
  return {
    writes,
    write_clock: clockStart(input.records, input.timed),
    views: simulation.omitted.views(state.views),
  };
};
