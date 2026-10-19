import * as t from "@babel/types";

import {
  semanticStaticPropertyKey,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";
import { semanticCallableResultExpressions } from "./javascriptSemanticCallableResults.js";
import { semanticBindingAtRead } from "./javascriptSemanticMutationInitializers.js";
import { semanticReferenceSourcesInactive } from "./javascriptSemanticReferenceSources.js";
import { semanticProjectedSourcesAtRead } from "./javascriptSemanticProjectedSources.js";
import {
  semanticPropertyPathKeyMatches,
  type JavaScriptSemanticPropertyPath,
} from "./javascriptSemanticPropertyPaths.js";
import {
  SemanticAliasSelections,
  semanticAliasSelectionChoices,
  type SemanticAliasSelectionPath,
} from "./javascriptSemanticAliasSelections.js";
import {
  resolveSemanticBindingState,
  type JavaScriptSemanticAnalysisState,
  type JavaScriptSemanticBindingState,
} from "./javascriptSemanticState.js";

/** A reference potentially handed to a caller or generator consumer. */
export interface SemanticReturnedReference {
  readonly node: t.Node;
  readonly projection: JavaScriptSemanticPropertyPath;
}

interface Candidate {
  readonly node: t.Node;
  /** `undefined` means any projection depth after different projection depths merge. */
  readonly path: SemanticAliasSelectionPath | undefined;
  /** Member selection happens at its use, while a captured function keeps its read. */
  readonly readAt?: t.Node;
}

export interface SemanticReturnedReferenceResult {
  readonly references: readonly SemanticReturnedReference[];
  /** Both states close the supported source-local may-target graph. Widened joins projections without dropping represented targets; it does not claim runtime completeness. */
  readonly precision: "exact" | "widened";
}

interface ObjectTargetIndex {
  readonly propertyByName: ReadonlyMap<
    string,
    t.ObjectMethod | t.ObjectProperty
  >;
  readonly trailingUnknownsByProperty: ReadonlyMap<
    t.ObjectMethod | t.ObjectProperty,
    ObjectTargetUnknown
  >;
}

interface ObjectTargetUnknown {
  readonly node: t.ObjectMethod | t.ObjectProperty | t.SpreadElement;
  readonly previous: ObjectTargetUnknown | undefined;
}

/** Resolve local result references conservatively, without claiming call execution. */
export const createSemanticReturnedReferences = (
  state: JavaScriptSemanticAnalysisState,
  consumption:
    | "potential-reference"
    | "direct-call"
    | "awaited-call" = "potential-reference",
): ((callee: t.Node) => SemanticReturnedReferenceResult) => {
  const results = new WeakMap<
    t.Node,
    {
      readonly result: SemanticReturnedReferenceResult;
      readonly iterationUnknown: boolean;
      readonly dependencies: readonly {
        readonly binding: JavaScriptSemanticBindingState;
        readonly writes: number;
        readonly escapes: number;
      }[];
    }
  >();
  const objectTargets = new WeakMap<t.ObjectExpression, ObjectTargetIndex>();
  return (callee) => {
    const existing = results.get(callee);
    if (
      existing !== undefined &&
      existing.iterationUnknown === state.arrayIterationUnknown &&
      existing.dependencies.every(
        ({ binding, writes, escapes }) =>
          binding.memberWrites.length === writes &&
          binding.escapedPaths.length === escapes,
      )
    )
      return existing.result;
    const dependencies = new Map<
      JavaScriptSemanticBindingState,
      { readonly writes: number; readonly escapes: number }
    >();
    const functions = new Set<t.Function>();
    const work: Candidate[] = [];
    // A transition depends on the source read and current projection, not the
    // initializer history used to reach it. Keeping history out of the key lets
    // shared diamonds and reassignment cycles converge to the graph fixed point.
    const projectionDepths = new WeakMap<
      t.Node,
      Map<string, number | undefined>
    >();
    const expanded = new WeakMap<t.Node, Set<string>>();
    const result: {
      references: readonly SemanticReturnedReference[];
      precision: SemanticReturnedReferenceResult["precision"];
    } = { references: [], precision: "exact" };
    // Exact finite alternatives retain unrelated keys and cross-path
    // correlations. Growing/shrinking cycles still converge at any depth;
    // selector-budget widening retains the complete may-target closure.
    const selections = new SemanticAliasSelections(() => {
      state.valueResourceLimits.add("alias-selections");
      result.precision = "widened";
    });
    const enqueue = (
      node: t.Node,
      path: Candidate["path"],
      readAt?: t.Node,
    ): void => {
      const source = unwrapJavaScriptExpression(node).node;
      const readKey = `${readAt?.start ?? -1}:${readAt?.end ?? -1}`;
      const depths = projectionDepths.get(source) ?? new Map();
      projectionDepths.set(source, depths);
      if (!depths.has(readKey)) {
        depths.set(readKey, path?.length);
      } else {
        const previous = depths.get(readKey);
        if (previous === undefined || previous !== path?.length) {
          if (previous !== undefined) result.precision = "widened";
          depths.set(readKey, undefined);
          path = undefined;
        }
      }
      if (path !== undefined) path = selections.normalize(source, path);
      const key = JSON.stringify([readKey, path ?? null]);
      const paths = expanded.get(source) ?? new Set<string>();
      if (paths.has(key)) return;
      paths.add(key);
      expanded.set(source, paths);
      work.push({
        node: source,
        path,
        ...(readAt === undefined ? {} : { readAt }),
      });
    };
    enqueue(callee, []);
    while (work.length > 0) {
      const current = work.pop();
      if (current === undefined) break;
      const { node } = current;
      const pending: Candidate[] = [];
      if (t.isIdentifier(node)) {
        const binding = resolveSemanticBindingState(state, node, node.name);
        if (binding === undefined) continue;
        dependencies.set(binding, {
          writes: binding.memberWrites.length,
          escapes: binding.escapedPaths.length,
        });
        if (current.path !== undefined) {
          const selectedSources = semanticProjectedSourcesAtRead(
            binding,
            current.readAt ?? node,
            current.path,
            state,
            false,
          );
          if (selectedSources !== undefined) {
            for (const source of selectedSources)
              pending.push({
                ...source,
                ...(current.path.length === 0
                  ? {}
                  : { readAt: current.readAt ?? node }),
              });
            for (let index = pending.length - 1; index >= 0; index--) {
              const child = pending[index];
              if (child !== undefined)
                enqueue(child.node, child.path, child.readAt);
            }
            continue;
          }
          result.precision = "widened";
        }
        const selected = semanticBindingAtRead(
          binding,
          current.readAt ?? node,
          state.parentsByNode,
        ).binding;
        for (const initializer of [
          ...selected.initializers,
          ...selected.referenceInitializers,
        ]) {
          if (semanticReferenceSourcesInactive(initializer, state)) continue;
          pending.push({
            node: initializer.node,
            path:
              current.path === undefined
                ? undefined
                : [...initializer.projection, ...current.path],
            ...(current.path?.length === 0
              ? {}
              : { readAt: current.readAt ?? node }),
          });
        }
        if (current.path === undefined)
          for (const effect of binding.memberWrites)
            for (const source of effect.assignedSources ?? [])
              if (!semanticReferenceSourcesInactive(source, state))
                pending.push({ node: source.node, path: undefined });
      } else if (
        t.isMemberExpression(node) ||
        t.isOptionalMemberExpression(node)
      ) {
        const path: (string | number | null)[] = [];
        let receiver: t.Node = node;
        while (
          t.isMemberExpression(receiver) ||
          t.isOptionalMemberExpression(receiver)
        ) {
          path.push(
            semanticStaticPropertyKey(receiver.property, receiver.computed),
          );
          receiver = unwrapJavaScriptExpression(receiver.object).node;
        }
        pending.push({
          ...current,
          node: receiver,
          readAt: current.readAt ?? node,
          path:
            current.path === undefined
              ? undefined
              : [...path.reverse(), ...current.path],
        });
      } else if (
        t.isConditionalExpression(node) ||
        t.isLogicalExpression(node)
      ) {
        pending.push(
          {
            ...current,
            node: t.isConditionalExpression(node) ? node.consequent : node.left,
          },
          {
            ...current,
            node: t.isConditionalExpression(node) ? node.alternate : node.right,
          },
        );
      } else if (t.isSequenceExpression(node)) {
        const last = node.expressions.at(-1);
        if (last !== undefined) pending.push({ ...current, node: last });
      } else if (
        t.isFunction(node) &&
        (current.path === undefined || current.path.length === 0)
      )
        functions.add(node);
      else if (t.isObjectExpression(node))
        selectObjectTargets(node, current, pending, objectTargets);
      else if (t.isArrayExpression(node)) {
        const [key, ...path] = current.path ?? [];
        let uncertainOffset = false;
        node.elements.forEach((element, offset) => {
          if (element === null) return;
          if (t.isSpreadElement(element)) {
            uncertainOffset = true;
            pending.push({
              ...current,
              node: element.argument,
              path: current.path === undefined ? undefined : [null, ...path],
            });
          } else if (
            current.path === undefined ||
            key === undefined ||
            uncertainOffset ||
            semanticAliasSelectionChoices(key).some((choice) =>
              semanticPropertyPathKeyMatches(choice, String(offset)),
            )
          )
            pending.push({
              ...current,
              node: element,
              path: current.path === undefined ? undefined : path,
            });
        });
      } else if (t.isNewExpression(node))
        pending.push({ ...current, node: node.callee });
      else if (t.isClass(node)) {
        const [key, ...path] = current.path ?? [];
        for (const member of node.body.body) {
          if (t.isClassMethod(member)) {
            if (
              ((current.path === undefined || current.path.length === 0) &&
                member.kind === "constructor") ||
              current.path === undefined ||
              (key !== undefined &&
                semanticAliasSelectionChoices(key).some((choice) => {
                  const name = semanticStaticPropertyKey(
                    member.key,
                    member.computed,
                  );
                  return (
                    name === null ||
                    semanticPropertyPathKeyMatches(choice, name)
                  );
                }))
            )
              pending.push({
                ...current,
                node: member,
                path: current.path === undefined ? undefined : path,
              });
          } else if (
            t.isClassProperty(member) &&
            member.value !== null &&
            member.value !== undefined &&
            (key !== undefined || current.path === undefined) &&
            (current.path === undefined ||
              (key !== undefined &&
                semanticAliasSelectionChoices(key).some((choice) => {
                  const name = semanticStaticPropertyKey(
                    member.key,
                    member.computed,
                  );
                  return (
                    name === null ||
                    semanticPropertyPathKeyMatches(choice, name)
                  );
                })))
          )
            pending.push({
              ...current,
              node: member.value,
              path: current.path === undefined ? undefined : path,
            });
        }
        if (node.superClass !== null && node.superClass !== undefined)
          pending.push({ ...current, node: node.superClass });
      }
      for (let index = pending.length - 1; index >= 0; index--) {
        const child = pending[index];
        if (child !== undefined) enqueue(child.node, child.path, child.readAt);
      }
    }
    const output = [...functions].flatMap((callable) => {
      // A direct generator/async call produces a fresh iterator/Promise, not
      // the yielded/resolved contents. Escape analysis still retains those
      // potential references for their eventual consumers.
      if (
        consumption !== "potential-reference" &&
        (callable.generator ||
          (consumption === "direct-call" && callable.async))
      )
        return [];
      return semanticCallableResultExpressions(callable).flatMap(
        ({ node, delegated, kind }) =>
          node === null ||
          (consumption !== "potential-reference" && kind !== "return")
            ? []
            : [{ node, projection: delegated ? [null] : [] }],
      );
    });
    result.references = output;
    results.set(callee, {
      result,
      iterationUnknown: state.arrayIterationUnknown,
      dependencies: [...dependencies].map(([binding, counts]) => ({
        binding,
        ...counts,
      })),
    });
    if (result.precision === "widened")
      state.returnedReferenceWidenings.add(callee);
    return result;
  };
};

const selectObjectTargets = (
  node: t.ObjectExpression,
  item: Candidate,
  pending: Candidate[],
  indexes: WeakMap<t.ObjectExpression, ObjectTargetIndex>,
): void => {
  const [key, ...path] = item.path ?? [];
  const childPath = item.path === undefined ? undefined : path;
  if (key !== null && typeof key === "object" && "alternatives" in key) {
    for (const choice of semanticAliasSelectionChoices(key))
      selectObjectTargets(
        node,
        { ...item, path: [choice, ...path] },
        pending,
        indexes,
      );
    return;
  }
  if (key !== null && key !== undefined && typeof key !== "object") {
    const index = objectTargetIndex(node, indexes);
    const property = index.propertyByName.get(String(key));
    if (property !== undefined) {
      const unknowns: ObjectTargetUnknown[] = [];
      for (
        let unknown = index.trailingUnknownsByProperty.get(property);
        unknown !== undefined;
        unknown = unknown.previous
      )
        unknowns.push(unknown);
      for (const { node: unknown } of unknowns.reverse())
        pending.push({
          ...item,
          node: t.isSpreadElement(unknown)
            ? unknown.argument
            : t.isObjectProperty(unknown)
              ? unknown.value
              : unknown,
          ...(t.isSpreadElement(unknown) ? {} : { path: childPath }),
        });
      pending.push({
        ...item,
        node: t.isObjectProperty(property) ? property.value : property,
        path: childPath,
      });
      return;
    }
  }
  let replaced = false;
  for (const property of [...node.properties].reverse()) {
    if (replaced) break;
    if (t.isSpreadElement(property)) {
      pending.push({ ...item, node: property.argument });
      continue;
    }
    const name = semanticStaticPropertyKey(property.key, property.computed);
    if (
      key !== null &&
      key !== undefined &&
      name !== null &&
      !semanticPropertyPathKeyMatches(key, name)
    )
      continue;
    if (t.isObjectProperty(property))
      pending.push({ ...item, node: property.value, path: childPath });
    else pending.push({ ...item, node: property, path: childPath });
    if (
      key !== null &&
      key !== undefined &&
      typeof key !== "object" &&
      name === String(key)
    )
      replaced = true;
  }
};

const objectTargetIndex = (
  node: t.ObjectExpression,
  indexes: WeakMap<t.ObjectExpression, ObjectTargetIndex>,
): ObjectTargetIndex => {
  const existing = indexes.get(node);
  if (existing !== undefined) return existing;
  const propertyByName = new Map<string, t.ObjectMethod | t.ObjectProperty>();
  const trailingUnknownsByProperty = new Map<
    t.ObjectMethod | t.ObjectProperty,
    ObjectTargetUnknown
  >();
  let trailingUnknown: ObjectTargetUnknown | undefined;
  for (const property of [...node.properties].reverse()) {
    if (t.isSpreadElement(property)) {
      trailingUnknown = { node: property, previous: trailingUnknown };
      continue;
    }
    const name = semanticStaticPropertyKey(property.key, property.computed);
    if (name === null) {
      trailingUnknown = { node: property, previous: trailingUnknown };
      continue;
    }
    if (propertyByName.has(name)) continue;
    propertyByName.set(name, property);
    if (trailingUnknown !== undefined)
      trailingUnknownsByProperty.set(property, trailingUnknown);
  }
  const created = { propertyByName, trailingUnknownsByProperty };
  indexes.set(node, created);
  return created;
};
