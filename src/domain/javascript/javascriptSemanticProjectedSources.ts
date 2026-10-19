import * as t from "@babel/types";
import type {
  JavaScriptSemanticAnalysisState,
  JavaScriptSemanticBindingState,
} from "./javascriptSemanticState.js";
import { semanticPropertyPathKeyMatches } from "./javascriptSemanticPropertyPaths.js";
import {
  semanticBindingAtRead,
  semanticDefiniteEffectPrecedesReference,
  semanticEffectTiming,
} from "./javascriptSemanticMutationInitializers.js";
import {
  semanticCopiedReferencePath,
  semanticReferenceIterationUnknown,
  semanticReferenceSourcesInactive,
} from "./javascriptSemanticReferenceSources.js";
import { semanticStoredSourceProjection } from "./javascriptSemanticIterationSources.js";
import {
  semanticAliasSelectionChoices,
  type SemanticAliasSelectionPath,
} from "./javascriptSemanticAliasSelections.js";

interface ProjectedSource {
  readonly node: t.Node;
  readonly path: SemanticAliasSelectionPath;
}

/** Select retained assignment and copy sources at one projected member read. */
export const semanticProjectedSourcesAtRead = (
  binding: JavaScriptSemanticBindingState,
  reference: t.Node,
  path: SemanticAliasSelectionPath,
  state: JavaScriptSemanticAnalysisState,
  includeUnknown: boolean,
): readonly ProjectedSource[] | undefined => {
  const matches = (
    effect: JavaScriptSemanticBindingState["memberWrites"][number],
  ) =>
    path.length > 0 &&
    effect.path.length <= path.length &&
    effect.path.every((key, index) => {
      const selected = path[index];
      return (
        selected !== undefined &&
        semanticAliasSelectionChoices(selected).some(
          (choice) =>
            choice === null ||
            typeof choice === "object" ||
            semanticPropertyPathKeyMatches(key, String(choice)),
        )
      );
    }) &&
    semanticEffectTiming(reference, effect.node, state) !== "after";
  const writes = binding.memberWrites.filter(matches);
  let replacement:
    | JavaScriptSemanticBindingState["memberWrites"][number]
    | undefined;
  for (const effect of writes) {
    if (
      t.isAssignmentExpression(effect.node, { operator: "=" }) &&
      effect.path.every(
        (key, index) =>
          key !== null &&
          typeof key !== "object" &&
          path[index] !== null &&
          typeof path[index] !== "object" &&
          String(key) === String(path[index]),
      ) &&
      semanticDefiniteEffectPrecedesReference(
        effect.node,
        reference,
        state.parentsByNode,
      ) &&
      (replacement === undefined ||
        semanticDefiniteEffectPrecedesReference(
          replacement.node!,
          effect.node,
          state.parentsByNode,
        ) ||
        (replacement.node === effect.node &&
          (replacement.assignedSources?.[0]?.target?.start ?? -1) <
            (effect.assignedSources?.[0]?.target?.start ?? -1)))
    )
      replacement = effect;
  }
  const superseded = (
    effect: JavaScriptSemanticBindingState["memberWrites"][number],
  ) =>
    replacement !== undefined &&
    effect.node !== undefined &&
    effect !== replacement &&
    (semanticEffectTiming(replacement.node!, effect.node, state) === "before" ||
      (effect.node === replacement.node &&
        (effect.assignedSources?.[0]?.target?.start ?? -1) <
          (replacement.assignedSources?.[0]?.target?.start ?? -1)));
  if (
    includeUnknown &&
    binding.escapedPaths.some(
      (effect) => matches(effect) && !superseded(effect),
    )
  )
    return undefined;
  const sources: ProjectedSource[] = [];
  for (const effect of writes) {
    if (superseded(effect)) continue;
    if (
      !t.isAssignmentExpression(effect.node) ||
      !["=", "||=", "&&=", "??="].includes(effect.node.operator)
    ) {
      if (includeUnknown) return undefined;
      continue;
    }
    if (effect.assignedSources === undefined) {
      if (includeUnknown) return undefined;
      continue;
    }
    const remaining = path.slice(effect.path.length);
    for (const source of effect.assignedSources) {
      if (semanticReferenceIterationUnknown(source, state)) return undefined;
      if (semanticReferenceSourcesInactive(source, state)) continue;
      const [key, ...suffix] = remaining;
      for (const choice of key === undefined
        ? [undefined]
        : semanticAliasSelectionChoices(key)) {
        const projection = semanticStoredSourceProjection(
          source,
          choice === undefined ? [] : [choice],
        );
        if (projection !== null)
          sources.push({ node: source.node, path: [...projection, ...suffix] });
      }
    }
  }
  if (replacement !== undefined) return sources;
  const read = semanticBindingAtRead(binding, reference, state.parentsByNode);
  for (const initializer of read.binding.initializers) {
    if (semanticReferenceIterationUnknown(initializer, state)) return undefined;
    if (semanticReferenceSourcesInactive(initializer, state)) continue;
    sources.push({
      node: initializer.node,
      path: [...initializer.projection, ...path],
    });
  }
  for (const initializer of read.binding.referenceInitializers) {
    if (semanticReferenceIterationUnknown(initializer, state)) return undefined;
    if (semanticReferenceSourcesInactive(initializer, state)) continue;
    const [key, ...suffix] = path;
    for (const choice of key === undefined
      ? [undefined]
      : semanticAliasSelectionChoices(key)) {
      const projection = semanticCopiedReferencePath(
        initializer,
        choice === undefined ? [] : [choice],
        "identity",
      );
      if (projection !== null)
        sources.push({
          node: initializer.node,
          path: [...projection, ...suffix],
        });
    }
  }
  return sources;
};
