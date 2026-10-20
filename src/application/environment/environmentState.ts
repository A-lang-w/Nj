import type { AnalysisViewResult } from "../../domain/analysisView/analysisView.js";
import {
  changesState,
  type StateDocument,
  type StateEntity,
  type StateType,
  type StateView,
} from "../../domain/analysisView/environmentStateRules.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type { AnalysisInputIssue } from "../../domain/analysisErrorCore.js";
import { err, ok, type Result } from "../../domain/result.js";
import {
  ENVIRONMENT_SERVE_OPERATION,
  inputError,
  parseViewEvidence,
  type EnvironmentManifestTool,
  type EnvironmentSource,
} from "./environmentSource.js";

type EnvironmentStateView = Extract<
  AnalysisViewResult,
  { kind: "environment-state" }
>;

/** The initial state an environment-state view extracted for the served manifest, authenticated and cross-checked. */
export interface EnvironmentState {
  readonly evidenceId: string;
  readonly types: readonly StateType[];
  /** Render plans keyed by tool name. */
  readonly views: ReadonlyMap<string, StateView>;
  readonly entities: readonly StateEntity[];
  readonly documents: readonly StateDocument[];
}

/** Serving from the state is read-only: tools whose requests may change state are not served. */
export const servedFromState = (tool: EnvironmentManifestTool): boolean =>
  !changesState(tool.method, tool.path_template);

const refusal = (
  operation: string,
  issue: AnalysisInputIssue,
  userMessage: string,
): AnalysisError =>
  inputError(
    operation,
    [{ ...issue, path: ["state", "normalized_result", ...issue.path] }],
    userMessage,
  );

/** Why the state does not belong to the served manifest and capture, if it does not. */
const stateMismatch = (
  operation: string,
  view: EnvironmentStateView,
  source: EnvironmentSource,
): AnalysisError | undefined => {
  if (view.parent_evidence_id !== source.evidenceId)
    return refusal(
      operation,
      {
        path: ["parent_evidence_id"],
        reason: "invalid_value",
        expected: source.evidenceId,
        message: `The state cites parent Evidence ${view.parent_evidence_id}; the evidence file is ${source.evidenceId}.`,
      },
      "The state was extracted from a different capture than the supplied evidence file.",
    );
  const rules = source.manifest.view.template_rules;
  if (
    view.view.template_rules.length !== rules.length ||
    view.view.template_rules.some((rule, index) => rule !== rules[index])
  )
    return refusal(
      operation,
      {
        path: ["view", "template_rules"],
        reason: "invalid_value",
        expected: [...rules],
        message:
          "The state must be extracted with the manifest's template_rules, in the same order, so its tool names are the manifest's.",
      },
      "The state was extracted with different template rules than the manifest.",
    );
  const tools = new Set(source.manifest.tools.map((tool) => tool.name));
  const index = view.views.findIndex((entry) => !tools.has(entry.tool));
  return index < 0
    ? undefined
    : refusal(
        operation,
        {
          path: ["views", index, "tool"],
          reason: "invalid_value",
          message: "Every state view must name a tool of the served manifest.",
        },
        "The state names a tool the manifest does not have.",
      );
};

/**
 * Load the environment-state Evidence for an already loaded manifest and
 * capture, refusing a state extracted from another capture or with other
 * template rules; refusals name the command that loaded it.
 */
export const loadEnvironmentState = (
  stateValue: unknown,
  source: EnvironmentSource,
  operation: string = ENVIRONMENT_SERVE_OPERATION,
): Result<EnvironmentState, AnalysisError> => {
  const parsed = parseViewEvidence(
    operation,
    "state",
    stateValue,
    "environment-state",
  );
  if (!parsed.ok) return parsed;
  const { view, evidenceId } = parsed.value;
  const mismatch = stateMismatch(operation, view, source);
  if (mismatch !== undefined) return err(mismatch);
  return ok({
    evidenceId,
    types: view.types,
    views: new Map(view.views.map((entry) => [entry.tool, entry])),
    entities: view.entities,
    documents: view.documents,
  });
};
