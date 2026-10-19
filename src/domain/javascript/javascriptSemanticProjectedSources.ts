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
  semanticTopLevelEffectFollowsCapture,
} from "./javascriptSemanticMutationInitializers.js";
import {
  semanticCopiedReferencePath,
  semanticReferenceIterationUnknown,
  semanticReferenceSourcesInactive,
} from "./javascriptSemanticReferenceSources.js";
import { semanticStoredSourceSelection } from "./javascriptSemanticIterationSources.js";
import {
  semanticAliasSelectionChoices,
  type SemanticAliasSelectionPath,
} from "./javascriptSemanticAliasSelections.js";

export interface SemanticCapturedSelection {
  readonly at: t.Node;
  readonly depth: number;
}

/** The next origin crossed owns a repeated copy boundary at the same depth. */
export const semanticNormalizeCapturedSelections = (
  selections: readonly SemanticCapturedSelection[] | undefined,
  pathLength?: number,
): readonly SemanticCapturedSelection[] | undefined => {
  const byDepth = new Map<number, SemanticCapturedSelection>();
  for (const capture of selections ?? [])
    if (
      capture.depth > 0 &&
      (pathLength === undefined || capture.depth <= pathLength)
    )
      byDepth.set(capture.depth, capture);
  const normalized = [...byDepth.values()].sort(
    (left, right) => left.depth - right.depth,
  );
  return normalized.length ? normalized : undefined;
};

/** Keep capture boundaries aligned as a selected prefix is added or consumed. */
export const semanticShiftCapturedSelections = (
  selections: readonly SemanticCapturedSelection[] | undefined,
  delta: number,
): readonly SemanticCapturedSelection[] | undefined => {
  const shifted = selections?.flatMap(({ at, depth }) =>
    depth + delta > 0 ? [{ at, depth: depth + delta }] : [],
  );
  return semanticNormalizeCapturedSelections(shifted);
};

interface ProjectedSource {
  readonly node: t.Node;
  readonly path: SemanticAliasSelectionPath;
  readonly capturedSelections?: readonly SemanticCapturedSelection[];
}

/** Select retained assignment and copy sources at one projected member read. */
export const semanticProjectedSourcesAtRead = (
  binding: JavaScriptSemanticBindingState,
  reference: t.Node,
  path: SemanticAliasSelectionPath,
  state: JavaScriptSemanticAnalysisState,
  includeUnknown: boolean,
  memberReadAt: t.Node = reference,
  capturedSelections: readonly SemanticCapturedSelection[] = [],
): readonly ProjectedSource[] | undefined => {
  const read = semanticBindingAtRead(binding, reference, state.parentsByNode);
  const captured = [
    ...read.binding.initializers,
    ...read.binding.referenceInitializers,
  ];
  const normalizedCaptures = semanticNormalizeCapturedSelections(
    capturedSelections,
    path.length,
  );
  const captureForDepth = (depth: number): t.Node | undefined =>
    normalizedCaptures?.find((capture) => capture.depth >= depth)?.at;
  const selectedAt = (depth: number): t.Node =>
    captureForDepth(depth) ?? memberReadAt;
  const samePrefix = (
    prefix: JavaScriptSemanticBindingState["memberWrites"][number],
    effect: JavaScriptSemanticBindingState["memberWrites"][number],
  ): boolean =>
    prefix.path.length < effect.path.length &&
    prefix.path.every(
      (key, index) =>
        key !== null &&
        typeof key !== "object" &&
        effect.path[index] !== null &&
        typeof effect.path[index] !== "object" &&
        String(key) === String(effect.path[index]),
    );
  const targetsReplacedPrefix = (
    effect: JavaScriptSemanticBindingState["memberWrites"][number],
  ): boolean =>
    capturedSelections.length > 0 &&
    binding.memberWrites.some((replacement) => {
      const capture = captureForDepth(replacement.path.length);
      const receiverAt = effect.receiverAt ?? effect.node;
      return (
        capture !== undefined &&
        receiverAt !== undefined &&
        t.isAssignmentExpression(replacement.node, { operator: "=" }) &&
        (t.isObjectExpression(replacement.node.right) ||
          t.isArrayExpression(replacement.node.right) ||
          t.isFunctionExpression(replacement.node.right) ||
          t.isArrowFunctionExpression(replacement.node.right) ||
          t.isClassExpression(replacement.node.right)) &&
        samePrefix(replacement, effect) &&
        semanticTopLevelEffectFollowsCapture(
          capture,
          replacement.node,
          state.parentsByNode,
        ) &&
        semanticDefiniteEffectPrecedesReference(
          replacement.node,
          receiverAt,
          state.parentsByNode,
        )
      );
    });
  const matches = (
    effect: JavaScriptSemanticBindingState["memberWrites"][number],
  ) =>
    (effect.receiverInitializers === undefined ||
      effect.receiverInitializers.length === 0 ||
      captured.length === 0 ||
      effect.receiverInitializers.some((receiver) =>
        captured.some(
          (source) =>
            source.node === receiver.node &&
            JSON.stringify(source.projection) ===
              JSON.stringify(receiver.projection),
        ),
      )) &&
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
    semanticEffectTiming(selectedAt(effect.path.length), effect.node, state) !==
      "after" &&
    !targetsReplacedPrefix(effect);
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
        selectedAt(effect.path.length),
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
        const selection = semanticStoredSourceSelection(
          source,
          choice === undefined ? [] : [choice],
        );
        if (selection !== null)
          sources.push({
            node: source.node,
            path: [...selection.projection, ...suffix],
            ...(selection.capturedSelectionDepth === undefined
              ? {}
              : {
                  capturedSelections: [
                    {
                      at: source.node,
                      depth: selection.capturedSelectionDepth,
                    },
                  ],
                }),
          });
      }
    }
  }
  if (replacement !== undefined) return sources;
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
          capturedSelections:
            initializer.copyProjectionOffset === undefined
              ? []
              : [
                  {
                    at: initializer.node,
                    depth: projection.length + suffix.length - path.length + 1,
                  },
                ],
        });
    }
  }
  return sources;
};
