import type { SemanticFlowProjectionContext } from "./JavaScriptSemanticGraphFlowProjection.js";
import type { JavaScriptSemanticIr } from "../../domain/javascript/javascriptSemanticIr.js";
import type { JavaScriptSourceRange } from "../../domain/javascript/javascriptStaticAnalysisTypes.js";

/** A folded top-level literal container assignment, ready for projection. */
export interface FoldedAssignedValue {
  readonly receiverName: string;
  readonly propertyPath: readonly string[];
  readonly value: JavaScriptSemanticIr["assignmentFlows"][number]["assignedValue"] extends
    | { value: infer V }
    | undefined
    ? V
    : never;
  readonly target: JavaScriptSourceRange;
}

/**
 * The unconditional top-level `X.p = { container }` assignments the graph may
 * model like initializers, after two filters:
 *
 * - repeated writers to one path keep only the last assignment;
 * - any other write intersecting the path (conditional, in a function, or a
 *   non-literal right-hand side) leaves the value unknown, matching the
 *   mutation semantics reads already apply.
 */
export const foldedAssignedContainerValues = (
  context: SemanticFlowProjectionContext,
): readonly FoldedAssignedValue[] => {
  const latest = new Map<string, FoldedAssignedValue>();
  for (const flow of context.ir.assignmentFlows) {
    if (flow.assignedValue === undefined) continue;
    latest.set(
      `${flow.assignedValue.receiverName} ${JSON.stringify(flow.assignedValue.propertyPath)}`,
      { ...flow.assignedValue, target: flow.target },
    );
  }
  // Every unconditional literal assignment to the path is exempt from the
  // intersecting-writer veto; only the last one's value survives.
  const foldedTargets = new Set(
    context.ir.assignmentFlows
      .filter((flow) => flow.assignedValue !== undefined)
      .map((flow) => JSON.stringify(flow.target)),
  );
  const candidates: FoldedAssignedValue[] = [];
  for (const folded of latest.values()) {
    const binding = context.ir.bindings.find(
      (candidate) => candidate.name === folded.receiverName,
    );
    if (binding === undefined) continue;
    const intersecting = context.ir.objectOperations.some(
      (operation) =>
        operation.kind === "write" &&
        operation.objectBindingId === binding.bindingId &&
        operation.propertyPath !== null &&
        propertyPathsIntersect(operation.propertyPath, folded.propertyPath) &&
        !foldedTargets.has(JSON.stringify(operation.location)),
    );
    if (intersecting) continue;
    candidates.push(folded);
  }
  return candidates;
};

/** Whether two static property paths share any prefix overlap. */
const propertyPathsIntersect = (
  left: readonly unknown[],
  right: readonly unknown[],
): boolean => {
  const shorter = Math.min(left.length, right.length);
  for (let index = 0; index < shorter; index += 1) {
    const a = left[index];
    const b = right[index];
    if (a === null || typeof a === "object") return true;
    if (b === null || typeof b === "object") return true;
    if (String(a) !== String(b)) return false;
  }
  return true;
};
