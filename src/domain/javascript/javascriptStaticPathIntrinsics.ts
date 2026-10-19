import type * as t from "@babel/types";

import { builtinDataEffectCallablePath } from "./javascriptSemanticDataEffectHelpers.js";
import type { JavaScriptBindingIndex } from "./javascriptSemanticState.js";
import { completeSemanticSteps } from "./javascriptSemanticTraversal.js";
import { evaluateSemanticExpressionProvenance } from "./javascriptSemanticValues.js";

/** Prove Node's path resolver before applying its argument-selection semantics. */
export const createStaticNodePathResolveQuery = (
  index: JavaScriptBindingIndex,
): ((callee: t.Node) => boolean) => {
  const facts = new WeakMap<t.Node, boolean>();
  return (callee) => {
    const cached = facts.get(callee);
    if (cached !== undefined) return cached;
    const provenance = evaluateSemanticExpressionProvenance(
      callee,
      index.bindings,
    );
    if (
      provenance.status !== "module" ||
      provenance.origins[0].importedPath.at(-1) !== "resolve" ||
      !["path", "node:path", "path/posix", "node:path/posix"].includes(
        provenance.origins[0].specifier,
      )
    ) {
      facts.set(callee, false);
      return false;
    }
    completeSemanticSteps(index.indexMemberMutationFactsSteps());
    const path = builtinDataEffectCallablePath(callee, index.bindings, [
      "path",
      "path/posix",
    ]);
    const proven =
      path !== null &&
      ((path.length === 1 && path[0] === "resolve") ||
        (path.length === 2 && path[0] === "posix" && path[1] === "resolve"));
    facts.set(callee, proven);
    return proven;
  };
};
