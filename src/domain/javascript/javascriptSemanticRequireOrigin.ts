import * as t from "@babel/types";
import { traverseJavaScriptAst } from "./javascriptSemanticTraversal.js";

import { BUILTIN_RESOURCE_METHODS } from "./javascriptBuiltinResourceMethods.js";
import type { JavaScriptModuleOrigin } from "./javascriptSemanticIr.js";
import {
  resolveSemanticBindingState,
  isUnmodifiedCommonJsWrapperBinding,
  commonJsWrapperBindingDeclaration,
  semanticResolutionBlocked,
  semanticStableInitializer,
  type JavaScriptSemanticAnalysisState,
  type JavaScriptSemanticBindingState,
} from "./javascriptSemanticState.js";
import {
  semanticStaticPropertyKey,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";
import { semanticPropertyPathKeyMatches } from "./javascriptSemanticPropertyPaths.js";
import { stringValue } from "./javascriptStaticAnalysisHelpers.js";
import {
  semanticEffectTiming,
  semanticBindingAtRead,
  semanticTopLevelEffectFollowsCapture,
  semanticDefiniteEffectPrecedesReference,
} from "./javascriptSemanticMutationInitializers.js";
import { createSemanticModuleInterop } from "./javascriptModuleInterop.js";
import {
  semanticCopiedReferencePath,
  semanticReferenceIterationUnknown,
  semanticReferenceSourcesInactive,
} from "./javascriptSemanticReferenceSources.js";
import {
  semanticIterationSources,
  semanticStoredSourceProjection,
} from "./javascriptSemanticIterationSources.js";
import {
  semanticArrayPropertyReferences,
  semanticObjectPropertyReferences,
} from "./javascriptSemanticObjectReferences.js";
import {
  SemanticAliasSelections,
  semanticAliasSelectionChoices,
  type SemanticAliasSelectionPath,
} from "./javascriptSemanticAliasSelections.js";

export interface JavaScriptRequireOrigin {
  readonly origin: JavaScriptModuleOrigin;
  readonly call: t.CallExpression;
}

export type JavaScriptRequireLoaderFact =
  | "commonjs-loader"
  | "factory-loader"
  | "create-require"
  | "local"
  | "unknown";

const possibleCommonJsDelegateWriteStates =
  new WeakSet<JavaScriptSemanticAnalysisState>();

/** Source eligibility only; the shared write owner still proves receiver identity. */
export const observePossibleCommonJsDelegateWrite = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
): void => {
  if (possibleCommonJsDelegateWriteStates.has(state)) return;
  const target = t.isAssignmentExpression(node)
    ? node.left
    : t.isUpdateExpression(node) ||
        t.isUnaryExpression(node, { operator: "delete" })
      ? node.argument
      : undefined;
  if (
    semanticIterationSources(node, state.parentsByNode.get(node) ?? null).some(
      (source) => source.kind === "reference-store",
    )
  )
    possibleCommonJsDelegateWriteStates.add(state);
  if (
    (t.isMemberExpression(target) || t.isOptionalMemberExpression(target)) &&
    ["require", null].includes(
      semanticStaticPropertyKey(target.property, target.computed),
    )
  )
    possibleCommonJsDelegateWriteStates.add(state);
  else if (t.isCallExpression(node) || t.isOptionalCallExpression(node))
    possibleCommonJsDelegateWriteStates.add(state);
};

export const hasPossibleCommonJsDelegateWrite = (
  state: JavaScriptSemanticAnalysisState,
): boolean => possibleCommonJsDelegateWriteStates.has(state);

/** Member effects settle at the shared indexing boundary, invalidating derived delegates. */
export const invalidateSemanticRequireDelegateWrites = (
  state: JavaScriptSemanticAnalysisState,
): void => {
  moduleRequireWrites.delete(state);
};

const commonJsDelegateChangedAt = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
): boolean =>
  writesModuleRequire(state).some(
    (write) => semanticEffectTiming(node, write, state) !== "after",
  );

const commonJsLoaderAt = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
): JavaScriptRequireLoaderFact =>
  commonJsDelegateChangedAt(node, state) ? "unknown" : "commonjs-loader";

/** Classify a bare `require(...)` using the shared lexical binding owner. */
export const semanticRequireLoaderAt = (
  node: t.CallExpression | t.OptionalCallExpression | t.NewExpression,
  state: JavaScriptSemanticAnalysisState,
  factoryBindingIds: ReadonlySet<string>,
): JavaScriptRequireLoaderFact => {
  const callee = unwrapJavaScriptExpression(node.callee).node;
  const loader = t.isIdentifier(callee, { name: "require" })
    ? callee
    : (t.isMemberExpression(callee) || t.isOptionalMemberExpression(callee)) &&
        ["resolve", "main"].includes(
          semanticStaticPropertyKey(callee.property, callee.computed) ?? "",
        ) &&
        t.isIdentifier(callee.object, { name: "require" })
      ? callee.object
      : undefined;
  if (loader === undefined) return "local";
  const binding = resolveSemanticBindingState(state, loader, "require");
  if (binding === undefined) {
    if (semanticResolutionBlocked(state, loader, "require")) return "unknown";
    return (state.ambientBindingWrites.get("require") ?? []).some(
      (write) => semanticEffectTiming(node, write, state) !== "after",
    )
      ? "unknown"
      : commonJsLoaderAt(node, state);
  }
  if (factoryBindingIds.has(binding.bindingId))
    return binding.initializers.length === 0 ? "factory-loader" : "unknown";
  if (
    binding.hostOrigin === "commonjs-wrapper" &&
    [...binding.declarationKinds].every((kind) => kind === "var")
  ) {
    if (binding.definitions.some(({ kind }) => kind === "function"))
      return "local";
    return commonJsWrapperBindingHasPriorWrite(node, binding, state)
      ? "unknown"
      : commonJsLoaderAt(node, state);
  }
  if (isWrapperRequireInitializerCall(binding, node, state))
    return commonJsLoaderAt(node, state);
  const wrapperBinding = commonJsWrapperBindingDeclaration(
    loader,
    "require",
    state,
  );
  if (
    wrapperBinding !== undefined &&
    !commonJsWrapperBindingHasPriorWrite(node, wrapperBinding, state)
  )
    return commonJsLoaderAt(node, state);
  if (isSemanticCreateRequireBinding(binding, state)) return "create-require";
  const initializer = semanticStableInitializer(binding, state)?.node;
  if (
    (binding.kind === "function" || binding.kind === "class") &&
    initializer !== undefined
  )
    return "local";
  if (
    binding.declarationKinds.size === 1 &&
    binding.declarationKinds.has("const") &&
    (t.isFunctionExpression(initializer) ||
      t.isArrowFunctionExpression(initializer))
  )
    return "local";
  return "unknown";
};

const commonJsWrapperBindingHasPriorWrite = (
  site: t.Node,
  binding: NonNullable<ReturnType<typeof resolveSemanticBindingState>>,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  const writes = state.bindingWrites.get(binding.bindingId) ?? [];
  const declarationInitializers = binding.initializers
    .map(({ node }) => node)
    .filter(
      (initializer) =>
        !writes.some((write) => semanticNodeWithin(initializer, write, state)),
    );
  return (
    writes.some(
      (write) => semanticEffectTiming(site, write, state) !== "after",
    ) ||
    declarationInitializers.some(
      (initializer) =>
        semanticEffectTiming(site, initializer, state) !== "after",
    )
  );
};

const semanticNodeWithin = (
  node: t.Node,
  ancestor: t.Node,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  let current: t.Node | undefined = node;
  while (current !== undefined) {
    if (current === ancestor) return true;
    current = state.parentsByNode.get(current);
  }
  return false;
};

/** Classify a call through an exact recovered factory-loader binding. */
export const semanticFactoryRequireLoaderAt = (
  node: t.CallExpression | t.OptionalCallExpression | t.NewExpression,
  state: JavaScriptSemanticAnalysisState,
  bindingIds: ReadonlySet<string>,
): JavaScriptRequireLoaderFact | undefined => {
  const callee = unwrapJavaScriptExpression(node.callee).node;
  if (t.isIdentifier(callee))
    return semanticFactoryLoaderMemberAt(node, state, bindingIds, null);
  if (
    (t.isMemberExpression(callee) || t.isOptionalMemberExpression(callee)) &&
    semanticStaticPropertyKey(callee.property, callee.computed) === "bind"
  )
    return semanticFactoryLoaderMemberAt(node, state, bindingIds, "bind");
  return undefined;
};

/** Classify an exact loader call by binding identity and expected member. */
export const semanticFactoryLoaderMemberAt = (
  node: t.CallExpression | t.OptionalCallExpression | t.NewExpression,
  state: JavaScriptSemanticAnalysisState,
  bindingIds: ReadonlySet<string>,
  member: string | null,
): JavaScriptRequireLoaderFact | undefined => {
  const callee = unwrapJavaScriptExpression(node.callee).node;
  let loader: t.Identifier | undefined;
  if (member === null) {
    if (t.isIdentifier(callee)) loader = callee;
  } else if (
    (t.isMemberExpression(callee) || t.isOptionalMemberExpression(callee)) &&
    semanticStaticPropertyKey(callee.property, callee.computed) === member
  ) {
    const root = unwrapJavaScriptExpression(callee.object).node;
    if (t.isIdentifier(root)) loader = root;
  }
  if (loader === undefined) return undefined;
  const binding = resolveSemanticBindingState(state, loader, loader.name);
  if (binding === undefined || !bindingIds.has(binding.bindingId))
    return undefined;
  return binding.initializers.length === 0 ? "factory-loader" : "unknown";
};

const isSemanticCreateRequireBinding = (
  binding: NonNullable<ReturnType<typeof resolveSemanticBindingState>>,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  if (binding.initializers.length !== 1) return false;
  const initializer = semanticStableInitializer(binding, state)?.node;
  if (!t.isCallExpression(initializer)) return false;
  const callee = unwrapJavaScriptExpression(initializer.callee).node;
  if (t.isIdentifier(callee)) {
    const origins = resolveSemanticBindingState(
      state,
      callee,
      callee.name,
    )?.directOrigins;
    if (origins?.length !== 1) return false;
    const [origin] = origins;
    return (
      origin?.importedPath.at(-1) === "createRequire" &&
      ["module", "node:module"].includes(origin.specifier)
    );
  }
  const chain = semanticMemberChain(callee);
  if (chain === undefined || chain.members.at(-1) !== "createRequire")
    return false;
  if (!t.isNode(chain.root)) return false;
  const root = unwrapJavaScriptExpression(chain.root).node;
  if (!t.isIdentifier(root)) return false;
  const origins = resolveSemanticBindingState(
    state,
    root,
    root.name,
  )?.directOrigins;
  if (origins?.length !== 1) return false;
  const [origin] = origins;
  return (
    origin?.importedPath.length === 0 &&
    ["module", "node:module"].includes(origin.specifier)
  );
};

/** The RHS call runs before its assignment replaces Node's wrapper loader. */
const isWrapperRequireInitializerCall = (
  binding: NonNullable<ReturnType<typeof resolveSemanticBindingState>>,
  node: t.CallExpression | t.OptionalCallExpression | t.NewExpression,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  const scope = state.scopesById.get(binding.scopeId);
  if (
    scope?.kind !== "program" ||
    binding.kind !== "variable" ||
    binding.declarationKinds.size !== 1 ||
    !binding.declarationKinds.has("var") ||
    binding.initializers.length !== 1 ||
    binding.initializers[0]?.node !== node
  )
    return false;
  const assignment = state.parentsByNode.get(node);
  if (
    !t.isAssignmentExpression(assignment) ||
    assignment.right !== node ||
    state.conditionallySkippedExpressions.has(node)
  )
    return false;
  const statement = state.parentsByNode.get(assignment);
  if (!t.isExpressionStatement(statement)) return false;
  if (state.parentsByNode.get(statement) !== state.program) return false;
  const target = unwrapJavaScriptExpression(assignment.left).node;
  return (
    t.isIdentifier(target, { name: "require" }) &&
    resolveSemanticBindingState(state, target, target.name) === binding
  );
};

// Ambient indexing finishes before these derived facts are consumed. Keep only
// replacement sites, rather than rescanning unrelated global member writes.
const globalProcessReplacements = new WeakMap<
  JavaScriptSemanticAnalysisState,
  readonly (t.Node | undefined)[]
>();
const moduleRequireWrites = new WeakMap<
  JavaScriptSemanticAnalysisState,
  readonly t.Node[]
>();

type ModuleObjectSource = {
  readonly node: t.Node;
  readonly path: SemanticAliasSelectionPath;
};

/** Retain assignment values, rather than equating any member write with module. */
const moduleObjectSourcesAtRead = (
  binding: JavaScriptSemanticBindingState,
  reference: t.Node,
  path: SemanticAliasSelectionPath,
  state: JavaScriptSemanticAnalysisState,
  includeUnknown: boolean,
): readonly ModuleObjectSource[] | undefined => {
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
  const sources: ModuleObjectSource[] = [];
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
      if (semanticReferenceIterationUnknown(source, state)) {
        if (includeUnknown) return undefined;
        continue;
      }
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
    if (semanticReferenceIterationUnknown(initializer, state)) {
      if (includeUnknown) return undefined;
      continue;
    }
    sources.push({
      node: initializer.node,
      path: [...initializer.projection, ...path],
    });
  }
  for (const initializer of read.binding.referenceInitializers) {
    if (semanticReferenceIterationUnknown(initializer, state)) {
      if (includeUnknown) return undefined;
      continue;
    }
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

const isCommonJsModuleObject = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
  includeUnknown = true,
): boolean => hasCommonJsModuleSource(node, state, includeUnknown, "module");

/** A captured delegate uses the same receiver and assignment ownership facts. */
export const isCommonJsRequireDelegate = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
  includeUnknown = false,
): boolean => hasCommonJsModuleSource(node, state, includeUnknown, "delegate");

const hasCommonJsModuleSource = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
  includeUnknown: boolean,
  target: "module" | "delegate",
): boolean => {
  type Work = ModuleObjectSource & { readonly ancestors: ReadonlySet<t.Node> };
  const pending: Work[] = [{ node, path: [], ancestors: new Set() }];
  // Keep depths separate and join finite key alternatives at each source read.
  const selections = new SemanticAliasSelections(() => {
    state.valueResourceLimits.add("alias-selections");
  });
  const examined = new WeakMap<t.Node, Set<string>>();
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const value = unwrapJavaScriptExpression(next.node).node;
    if (next.ancestors.has(value)) {
      if (includeUnknown) return true;
      continue;
    }
    const ancestors = new Set([...next.ancestors, value]);
    const enqueue = (...sources: ModuleObjectSource[]) => {
      pending.push(...sources.map((source) => ({ ...source, ancestors })));
    };
    const path = selections.normalize(value, next.path);
    if (selections.limited) return true;
    const byPath = examined.get(value) ?? new Set<string>();
    const identity = JSON.stringify(path);
    if (byPath.has(identity)) continue;
    byPath.add(identity);
    examined.set(value, byPath);
    if (t.isMemberExpression(value) || t.isOptionalMemberExpression(value)) {
      enqueue({
        node: value.object,
        path: [
          semanticStaticPropertyKey(value.property, value.computed),
          ...path,
        ],
      });
      continue;
    }
    if (
      path.length > 0 &&
      (t.isObjectExpression(value) || t.isArrayExpression(value))
    ) {
      const [key, ...remaining] = path;
      if (key !== undefined)
        for (const choice of semanticAliasSelectionChoices(key))
          enqueue(
            ...(t.isObjectExpression(value)
              ? semanticObjectPropertyReferences(value, [choice], state)
              : semanticArrayPropertyReferences(value, [choice])
            ).map((source) => ({
              node: source.node,
              path: [...source.path, ...remaining],
            })),
          );
      continue;
    }
    if (t.isConditionalExpression(value) || t.isLogicalExpression(value)) {
      enqueue(
        {
          node: t.isConditionalExpression(value)
            ? value.consequent
            : value.left,
          path,
        },
        {
          node: t.isConditionalExpression(value)
            ? value.alternate
            : value.right,
          path,
        },
      );
      continue;
    }
    if (!t.isIdentifier(value)) continue;
    const binding = resolveSemanticBindingState(state, value, value.name);
    if (value.name === "module" && binding === undefined) {
      if (
        (target === "module"
          ? path.length === 0
          : path.length === 1 &&
            semanticAliasSelectionChoices(path[0]!).some(
              (key) =>
                key === null || semanticPropertyPathKeyMatches(key, "require"),
            )) &&
        !semanticResolutionBlocked(state, value, "module")
      )
        return true;
      continue;
    }
    if (binding === undefined) continue;
    const read = semanticBindingAtRead(binding, value, state.parentsByNode);
    if (
      value.name === "module" &&
      (target === "module"
        ? path.length === 0
        : path.length === 1 &&
          semanticAliasSelectionChoices(path[0]!).some(
            (key) =>
              key === null || semanticPropertyPathKeyMatches(key, "require"),
          )) &&
      commonJsWrapperBindingDeclaration(value, "module", state) !== undefined &&
      !read.hasDefiniteInitializer
    )
      return true;
    const sources = moduleObjectSourcesAtRead(
      binding,
      value,
      path,
      state,
      includeUnknown,
    );
    if (sources === undefined) return true;
    enqueue(...sources);
  }
  return false;
};

/** Select an unchecked member-loader receiver before its identity is examined. */
export const semanticModuleRequireReceiver = (
  node: t.CallExpression | t.OptionalCallExpression | t.NewExpression,
): t.Node | undefined => {
  let callee = unwrapJavaScriptExpression(node.callee).node;
  while (
    (t.isMemberExpression(callee) || t.isOptionalMemberExpression(callee)) &&
    ["bind", "call", "apply"].includes(
      semanticStaticPropertyKey(callee.property, callee.computed) ?? "",
    )
  )
    // Capturing a bound delegate can load outside the visible module graph.
    // Keep that possibility without asserting bind/call/apply is unmodified.
    callee = unwrapJavaScriptExpression(callee.object).node;
  return (t.isMemberExpression(callee) ||
    t.isOptionalMemberExpression(callee)) &&
    semanticStaticPropertyKey(callee.property, callee.computed) === "require"
    ? callee.object
    : undefined;
};

/** Recognize an unchecked module loader without asserting its current delegate. */
export const semanticModuleRequireCallAt = (
  node: t.CallExpression | t.OptionalCallExpression | t.NewExpression,
  state: JavaScriptSemanticAnalysisState,
  includeUnknown = true,
): boolean => {
  const receiver = semanticModuleRequireReceiver(node);
  if (receiver !== undefined)
    return isCommonJsModuleObject(receiver, state, includeUnknown);
  let target = unwrapJavaScriptExpression(node.callee).node;
  while (
    (t.isMemberExpression(target) || t.isOptionalMemberExpression(target)) &&
    ["bind", "call", "apply"].includes(
      semanticStaticPropertyKey(target.property, target.computed) ?? "",
    )
  )
    target = unwrapJavaScriptExpression(target.object).node;
  return isCommonJsRequireDelegate(target, state, includeUnknown);
};

const writesModuleRequire = (
  state: JavaScriptSemanticAnalysisState,
): readonly t.Node[] => {
  const cached = moduleRequireWrites.get(state);
  if (cached !== undefined) return cached;
  // Interop invocation resolution may ask for require provenance while this
  // index is being built. Publish a temporary empty result to break that cycle.
  moduleRequireWrites.set(state, []);
  const writes: t.Node[] = [];
  const interop = createSemanticModuleInterop(state);
  const isModuleObject = (node: t.Node): boolean =>
    // Only a retained module identity can revoke the host delegate. Escaping
    // an unrelated local table is not evidence that it became the host module.
    isCommonJsModuleObject(node, state, false);
  traverseJavaScriptAst(state.program, {
    enter: (node) => {
      const target = t.isAssignmentExpression(node)
        ? node.left
        : t.isUpdateExpression(node) ||
            t.isUnaryExpression(node, { operator: "delete" })
          ? node.argument
          : undefined;
      if (
        t.isMemberExpression(target) ||
        t.isOptionalMemberExpression(target)
      ) {
        const key = semanticStaticPropertyKey(target.property, target.computed);
        if (
          (key === "require" || (key === null && target.computed)) &&
          isModuleObject(target.object)
        )
          writes.push(node);
      }
      if (t.isCallExpression(node) || t.isOptionalCallExpression(node)) {
        const invocation = interop.intrinsicInvocation(node);
        const owner =
          invocation?.path?.length === 3 ? invocation.path[1] : undefined;
        const method = invocation?.path?.at(-1);
        const args = invocation?.arguments;
        if (
          (owner === "Object" || owner === "Reflect") &&
          method === "defineProperty" &&
          isModuleObject(args?.[0] ?? t.nullLiteral())
        ) {
          const key = interop.staticString(args?.[1]);
          if (key === "require" || key === undefined) writes.push(node);
        } else if (
          owner === "Object" &&
          method === "defineProperties" &&
          isModuleObject(args?.[0] ?? t.nullLiteral())
        ) {
          const descriptors = args?.[1];
          if (
            !t.isObjectExpression(descriptors) ||
            descriptors.properties.some(
              (property) =>
                t.isSpreadElement(property) ||
                (t.isObjectProperty(property) &&
                  semanticStaticPropertyKey(property.key, property.computed) ===
                    "require"),
            )
          )
            writes.push(node);
        } else if (
          owner === "Object" &&
          method === "assign" &&
          args?.some((arg) => isModuleObject(arg))
        ) {
          const target = args?.[0];
          if (target !== undefined && isModuleObject(target)) {
            const sourceHasRequire = args
              ?.slice(1)
              .some(
                (arg) =>
                  t.isObjectExpression(arg) &&
                  arg.properties.some(
                    (property) =>
                      t.isObjectProperty(property) &&
                      semanticStaticPropertyKey(
                        property.key,
                        property.computed,
                      ) === "require",
                  ),
              );
            if (
              sourceHasRequire ||
              args?.slice(1).some((arg) => !t.isObjectExpression(arg))
            )
              writes.push(node);
          }
        }
      }
    },
  });
  moduleRequireWrites.set(state, writes);
  return writes;
};

/** Whether the original global process object can still own effects at this source site. */
export const semanticOriginalGlobalProcessAt = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  let replacements = globalProcessReplacements.get(state);
  if (replacements === undefined) {
    replacements = [
      ...state.ambientWriteEffects
        .filter(
          ({ path }) =>
            path.length <= 2 &&
            path.every((key, index) =>
              semanticPropertyPathKeyMatches(
                key,
                ["global", "process"][index]!,
              ),
            ),
        )
        .map(({ node: write }) => write),
      ...(state.ambientBindingWrites.get("process") ?? []),
    ];
    globalProcessReplacements.set(state, replacements);
  }
  return !replacements.some(
    (write) =>
      !semanticTopLevelEffectFollowsCapture(node, write, state.parentsByNode),
  );
};

/** Node's unbound process reference shares the cached process exports object. */
export const semanticGlobalProcessOrigin = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
): JavaScriptModuleOrigin | undefined =>
  t.isIdentifier(node, { name: "process" }) &&
  resolveSemanticBindingState(state, node, "process") === undefined &&
  !semanticResolutionBlocked(state, node, "process") &&
  semanticOriginalGlobalProcessAt(node, state)
    ? { specifier: "node:process", importedPath: [], resolutionMode: "require" }
    : undefined;

/** Resolve qualified global-object process references, preserving their selected path. */
export const semanticGlobalProcessPathOrigin = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
): JavaScriptModuleOrigin | undefined => {
  const members: string[] = [];
  let current = unwrapJavaScriptExpression(node).node;
  while (
    t.isMemberExpression(current) ||
    t.isOptionalMemberExpression(current)
  ) {
    const key = semanticStaticPropertyKey(current.property, current.computed);
    if (key === null) return undefined;
    members.unshift(key);
    current = unwrapJavaScriptExpression(current.object).node;
  }
  if (
    !t.isIdentifier(current) ||
    !["globalThis", "global", "window", "self"].includes(current.name) ||
    resolveSemanticBindingState(state, current, current.name) !== undefined ||
    semanticResolutionBlocked(state, current, current.name) ||
    members[0] !== "process" ||
    !semanticOriginalGlobalProcessAt(node, state)
  )
    return undefined;
  return {
    specifier: "node:process",
    importedPath: members.slice(1),
    resolutionMode: "require",
  };
};

/** Strip a static member chain, returning its root expression and member path. */
export const semanticMemberChain = (
  node: t.Node | null | undefined,
):
  | { readonly root: t.Node | null | undefined; readonly members: string[] }
  | undefined => {
  const members: string[] = [];
  let current = node;
  while (current !== null && current !== undefined) {
    current = unwrapJavaScriptExpression(current).node;
    if (
      !t.isMemberExpression(current) &&
      !t.isOptionalMemberExpression(current)
    )
      break;
    const member = semanticStaticPropertyKey(
      current.property,
      current.computed,
    );
    if (member === null || !t.isNode(current.object)) return undefined;
    members.push(member);
    current = current.object;
  }
  return { root: current, members: members.reverse() };
};

/** Recover an unshadowed literal require origin and its exact member path. */
export const semanticRequireOrigin = (
  node: t.Node | null | undefined,
  state: JavaScriptSemanticAnalysisState,
): JavaScriptRequireOrigin | undefined => {
  const chain = semanticMemberChain(node);
  const current = chain?.root;
  if (
    chain === undefined ||
    !t.isCallExpression(current) ||
    !t.isIdentifier(current.callee, { name: "require" })
  )
    return undefined;
  if (commonJsDelegateChangedAt(current, state)) return undefined;
  const requireBinding = resolveSemanticBindingState(
    state,
    current.callee,
    "require",
  );
  if (
    (requireBinding !== undefined &&
      !isUnmodifiedCommonJsWrapperBinding(current.callee, "require", state) &&
      !isWrapperRequireInitializerCall(requireBinding, current, state)) ||
    (requireBinding === undefined &&
      semanticResolutionBlocked(state, current.callee, "require")) ||
    (state.ambientBindingWrites.get("require") ?? []).some(
      (write) =>
        !semanticTopLevelEffectFollowsCapture(
          current,
          write,
          state.parentsByNode,
        ),
    )
  )
    return undefined;
  const specifier = stringValue(current.arguments[0]);
  return specifier === undefined
    ? undefined
    : {
        origin: {
          specifier,
          importedPath: chain.members,
          resolutionMode: "require",
        },
        call: current,
      };
};

/** Node's fs.promises export and fs/promises require share one object. */
export const semanticRequireExportsIdentity = <Key>(
  specifier: string,
  path: readonly Key[],
): { readonly specifier: string; readonly path: readonly (Key | string)[] } => {
  const name = specifier.replace(/^node:/u, "");
  if (name === "fs/promises") return { specifier: name, path };
  return name === "fs" && path[0] === "promises" && path.length > 1
    ? { specifier: "fs/promises", path: path.slice(1) }
    : { specifier: name, path };
};

const MUTABLE_BUILTIN_DEFAULTS = new Set([
  ...Object.keys(BUILTIN_RESOURCE_METHODS),
  "http",
  "https",
  "child_process",
  "timers",
  "process",
]);

/** Mutable default/object selections share CommonJS identity; namespace slots do not. */
export const semanticMutableBuiltinOrigin = <Key = never>(
  origin: JavaScriptModuleOrigin,
  selected: readonly Key[] = [],
):
  | { readonly specifier: string; readonly path: readonly (Key | string)[] }
  | undefined => {
  const path = [...origin.importedPath, ...selected];
  if (origin.resolutionMode === "require")
    return { specifier: origin.specifier, path };
  const specifier = origin.specifier.replace(/^node:/u, "");
  if (!MUTABLE_BUILTIN_DEFAULTS.has(specifier)) return undefined;
  if (path[0] === "default") return { specifier, path: path.slice(1) };
  if (specifier === "process" && (path[0] === "env" || path[0] === "argv"))
    return { specifier, path };
  return specifier === "fs" && path[0] === "promises"
    ? { specifier, path }
    : undefined;
};
