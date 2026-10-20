import { AnalysisOutputError } from "../../domain/analysisErrorCore.js";

/**
 * The provider whose session refuses an external mutation.
 *
 * A Ghidra session holds ephemeral analysis edits. An external command may
 * write the artifact behind the session's back, so such a session has to be
 * closed explicitly before the command runs.
 */
const EXCLUDED_PROVIDER_ID = "ghidra";

/** Whether a session bound to this provider refuses an external mutation. */
export const refusesExternalMutation = (providerId: string): boolean =>
  providerId === EXCLUDED_PROVIDER_ID;

/** The refusal a session gives when an external mutation would discard its edits. */
export const externalMutationRefusal = (
  operationName: string,
): AnalysisOutputError =>
  new AnalysisOutputError(
    operationName,
    "Close the active Ghidra session explicitly before an external mutation; rebinding would discard its ephemeral analysis edits.",
  );
