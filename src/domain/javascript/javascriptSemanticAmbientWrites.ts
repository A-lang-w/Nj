import * as t from "@babel/types";

import {
  semanticStaticPropertyKey,
  readExactJavaScriptLiteral,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";
import {
  collectJavaScriptIdentityWritesSteps,
  electronMemberPath,
} from "./javascriptElectronMemberWrites.js";
import { createSemanticModuleInterop } from "./javascriptModuleInterop.js";
import { semanticPropertyPathKeyMatches } from "./javascriptSemanticPropertyPaths.js";
import {
  isUnshadowedGlobal,
  resolveSemanticBindingState,
  semanticStableInitializer,
  type JavaScriptSemanticAnalysisState,
} from "./javascriptSemanticState.js";
import { isImportMetaUrl } from "./javascriptStaticAnalysisHelpers.js";
import {
  semanticBindingAtRead,
  semanticDefiniteEffectPrecedesReference,
  semanticEffectTiming,
} from "./javascriptSemanticMutationInitializers.js";
import { SEMANTIC_ALIAS_SELECTION_LIMIT } from "./javascriptSemanticResourceLimits.js";
import {
  semanticIterationSources,
  type SemanticIterationSource,
} from "./javascriptSemanticIterationSources.js";
import { createSemanticReturnedReferences } from "./javascriptSemanticReturnedReferences.js";
import {
  semanticCopiedReferencePath,
  semanticReferenceIterationUnknown,
  semanticReferenceSourcesInactive,
} from "./javascriptSemanticReferenceSources.js";

const GLOBAL_OBJECT_NAMES = ["globalThis", "global", "window", "self"];

// These static builtins do not give their namespace receiver to user code.
const NATIVE_NAMESPACE_METHODS = {
  Object: new Set([
    "assign",
    "create",
    "defineProperty",
    "defineProperties",
    "entries",
    "freeze",
    "fromEntries",
    "getOwnPropertyDescriptor",
    "getOwnPropertyDescriptors",
    "getOwnPropertyNames",
    "getOwnPropertySymbols",
    "getPrototypeOf",
    "groupBy",
    "hasOwn",
    "is",
    "isExtensible",
    "isFrozen",
    "isSealed",
    "keys",
    "preventExtensions",
    "seal",
    "setPrototypeOf",
    "values",
  ]),
  Reflect: new Set([
    "apply",
    "construct",
    "defineProperty",
    "deleteProperty",
    "get",
    "getOwnPropertyDescriptor",
    "getPrototypeOf",
    "has",
    "isExtensible",
    "ownKeys",
    "preventExtensions",
    "set",
    "setPrototypeOf",
  ]),
};

const globalObjectName = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
): string | undefined =>
  GLOBAL_OBJECT_NAMES.find((name) => isUnshadowedGlobal(node, state, name));

/** Global self references retain object identity, rather than adding a property. */
const canonicalAmbientPath = (
  path: readonly (string | null)[],
): readonly (string | null)[] => {
  if (path[0] !== "global") return path;
  let firstProperty = 1;
  while (GLOBAL_OBJECT_NAMES.includes(path[firstProperty] ?? ""))
    firstProperty += 1;
  return ["global", ...path.slice(firstProperty)];
};

type AmbientPath = readonly (string | null)[];

const retainedAmbientEffects = new WeakMap<
  JavaScriptSemanticAnalysisState,
  Map<t.Node | undefined, Set<string>>
>();

/** Retain canonical ambient effects once, whether discovered by syntax or receiver expansion. */
export const retainSemanticAmbientEffect = (
  state: JavaScriptSemanticAnalysisState,
  kind: "write" | "escape",
  path: AmbientPath,
  node: t.Node | undefined,
): boolean => {
  const selected = kind === "escape" ? [...path, null] : path;
  const byNode = retainedAmbientEffects.get(state) ?? new Map();
  const keys = byNode.get(node) ?? new Set<string>();
  const key = JSON.stringify([kind, selected]);
  if (keys.has(key)) return false;
  keys.add(key);
  byNode.set(node, keys);
  retainedAmbientEffects.set(state, byNode);
  if (kind === "write") {
    state.ambientWrites.retain(selected);
    state.ambientWriteEffects.push({ path: selected, node });
  } else {
    state.ambientEscapes.retain(selected);
    state.ambientEscapeEffects.push({ path: selected, node });
  }
  return true;
};

/** Parsed receiver facts stay separate from mutation-dependent safety. */
export const semanticIntrinsicReceiverIsSafe = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  const path = state.intrinsicReceiverCalls.get(node);
  if (path === undefined) return false;
  if (!state.ambientWrites.covers(path) && !state.ambientEscapes.covers(path))
    return true;
  const affects = (
    effect: JavaScriptSemanticAnalysisState["ambientWriteEffects"][number],
  ) =>
    semanticEffectTiming(node, effect.node, state) !== "after" &&
    effect.path.length <= path.length &&
    effect.path.every((key, index) =>
      semanticPropertyPathKeyMatches(key, path[index] ?? ""),
    );
  return (
    !state.ambientWriteEffects.some(affects) &&
    !state.ambientEscapeEffects.some(affects)
  );
};

/** Undefined means a cyclic or conflicting projection can select any depth. */
type AmbientProjection = AmbientPath | undefined;

const joinAmbientProjection = (
  left: AmbientProjection,
  right: AmbientProjection,
): AmbientProjection =>
  left === undefined || right === undefined || left.length !== right.length
    ? undefined
    : left.map((key, index) => (key === right[index] ? key : null));

interface AmbientReferenceFacts {
  readonly stores: WeakMap<
    t.Node,
    Map<SemanticIterationSource, AmbientProjection>
  >;
  readonly prototypeTarget: (node: t.Node) => t.Node | undefined;
  readonly freshObject: (node: t.Node) => boolean;
}

/**
 * Follow local object identities without equating shallow copies with their
 * sources. Writes select aliases at their capture; uncertain execution order
 * retains possible initializers. Intrinsic reads stay strict.
 */
export const createAmbientPathResolver = (
  state: JavaScriptSemanticAnalysisState,
  possibleWrites: boolean,
  facts?: AmbientReferenceFacts,
) => {
  const cached = new WeakMap<t.Node, readonly AmbientPath[]>();
  const returnedReferences = createSemanticReturnedReferences(state);
  return (
    node: t.Node,
    capture?: t.Node,
    escapedContents = false,
    projection: AmbientProjection = [],
    selection?: {
      readonly localIdentity?: (node: t.Node, path: AmbientProjection) => void;
      readonly prototypeReceiver?: boolean;
    },
  ): readonly AmbientPath[] => {
    const prior = possibleWrites ? undefined : cached.get(node);
    if (prior !== undefined) return prior;
    const result = new Map<string, AmbientPath>();
    // The caller's write site selects initializers for the written target.
    // Reads reached through an initializer occur at their own position.
    const pending: {
      node: t.Node;
      suffix: AmbientProjection;
      readsAtSelf?: true;
      prototypeDepths?: readonly number[];
      prototypeReadAt?: t.Node;
    }[] = [{ node, suffix: projection }];
    // Join projections at their producing expression, rather than enumerating
    // alias histories. Each key can only widen to a wildcard, and conflicting
    // depths widen to unknown, so diamonds and cycles have finite state.
    const expanded = new WeakMap<t.Node, Map<string, AmbientProjection>>();
    let prototypeStates = 0;
    const retain = (path: AmbientPath) => {
      let canonical = canonicalAmbientPath(path);
      for (;;) {
        result.set(JSON.stringify(canonical), canonical);
        if (
          possibleWrites &&
          canonical[0] === "global" &&
          canonical[2] === "prototype" &&
          canonical[3] === "constructor"
        ) {
          canonical = ["global", canonical[1] ?? null, ...canonical.slice(4)];
          continue;
        }
        // An unknown key may select a global self reference as well as a
        // distinct property. Retain both possible object identities for writes.
        if (
          !possibleWrites ||
          canonical[0] !== "global" ||
          canonical[1] !== null
        )
          break;
        canonical = canonicalAmbientPath(["global", ...canonical.slice(2)]);
      }
    };
    while (pending.length > 0) {
      const current = pending.pop();
      if (current === undefined) break;
      const { root, members } = electronMemberPath(current.node);
      let suffix: AmbientProjection =
        current.suffix === undefined
          ? undefined
          : [...members, ...current.suffix];
      const prototypeDepths = (current.prototypeDepths ?? []).map(
        (depth) => depth + members.length,
      );
      const prototypeReadAt = members.includes("__proto__")
        ? current.node
        : current.prototypeReadAt;
      if (
        prototypeDepths.length > 0 &&
        ++prototypeStates > SEMANTIC_ALIAS_SELECTION_LIMIT
      ) {
        state.valueResourceLimits.add("alias-selections");
        retain(["global", null]);
        continue;
      }
      const selectionKey = JSON.stringify([
        prototypeDepths,
        prototypeReadAt?.start,
        prototypeReadAt?.end,
      ]);
      const bySelection =
        expanded.get(root) ?? new Map<string, AmbientProjection>();
      if (bySelection.has(selectionKey)) {
        const previous = bySelection.get(selectionKey);
        if (previous === undefined) continue;
        if (suffix !== undefined && previous.length === suffix.length) {
          const joined: AmbientPath = previous.map((key, index) =>
            key === suffix?.[index] ? key : null,
          );
          if (joined.every((key, index) => key === previous[index])) continue;
          suffix = joined;
        } else suffix = undefined;
        if (!possibleWrites) {
          cached.set(node, []);
          return [];
        }
      }
      bySelection.set(selectionKey, suffix);
      expanded.set(root, bySelection);
      // A widened projection is a possible write, never proof of an intrinsic.
      if (suffix === undefined && !possibleWrites) continue;
      const shiftPrototypeDepths = (path: AmbientProjection) =>
        path === undefined || suffix === undefined
          ? []
          : prototypeDepths
              .map((depth) => depth + path.length - suffix.length)
              .filter((depth) => depth >= 0);
      const continueWith = (
        node: t.Node,
        path: AmbientProjection = suffix,
        depths = shiftPrototypeDepths(path),
        readAt = prototypeReadAt,
      ) =>
        pending.push({
          node,
          suffix: path,
          ...(depths.length === 0 ? {} : { prototypeDepths: depths }),
          ...(readAt === undefined ? {} : { prototypeReadAt: readAt }),
          ...(current.readsAtSelf && { readsAtSelf: true }),
        });
      const continueReturned = (callee: t.Node, path: AmbientProjection) => {
        for (const source of returnedReferences(callee).references)
          continueWith(
            source.node,
            path === undefined
              ? undefined
              : [
                  ...source.projection.map((key) =>
                    key === null || typeof key === "object"
                      ? null
                      : String(key),
                  ),
                  ...path,
                ],
          );
      };
      if (!t.isIdentifier(root) && facts?.freshObject(root)) {
        selection?.localIdentity?.(root, suffix);
        for (const [source, path] of facts?.stores.get(root) ?? []) {
          const selected =
            suffix === undefined ||
            path === undefined ||
            path.every(
              (key, index) =>
                index >= suffix.length ||
                key === null ||
                suffix[index] === null ||
                key === suffix[index],
            );
          if (
            !selected ||
            (suffix !== undefined &&
              path !== undefined &&
              suffix.length < path.length &&
              !escapedContents)
          )
            continue;
          const remaining =
            suffix === undefined || path === undefined
              ? undefined
              : suffix.slice(path.length);
          pending.push({
            node: source.node,
            readsAtSelf: true,
            ...(prototypeReadAt === undefined ? {} : { prototypeReadAt }),
            prototypeDepths:
              suffix === undefined || path === undefined
                ? []
                : prototypeDepths
                    .map(
                      (depth) => depth + source.projection.length - path.length,
                    )
                    .filter((depth) => depth >= 0),
            suffix:
              remaining === undefined
                ? undefined
                : [
                    ...source.projection.map((key) =>
                      key === null || typeof key === "object"
                        ? null
                        : String(key),
                    ),
                    ...remaining,
                  ],
          });
        }
      }
      if (
        t.isMetaProperty(root) &&
        root.meta.name === "import" &&
        root.property.name === "meta"
      ) {
        retain(["import-meta", ...(suffix ?? [])]);
        continue;
      }
      if (t.isIdentifier(root)) {
        // The wrapper module object is distinct from globalThis.module. Keep
        // its identity through the same alias/projection owner used for writes.
        if (isUnshadowedGlobal(root, state, "module")) {
          retain(["commonjs-module", ...(suffix ?? [])]);
          continue;
        }
        if (globalObjectName(root, state) !== undefined) {
          retain(["global", ...(suffix ?? [])]);
          continue;
        }
        if (isUnshadowedGlobal(root, state, root.name)) {
          retain(["global", root.name, ...(suffix ?? [])]);
          continue;
        }
        const binding = resolveSemanticBindingState(state, root, root.name);
        if (binding === undefined) continue;
        const stable = possibleWrites
          ? undefined
          : semanticStableInitializer(binding, state);
        const readAt = current.readsAtSelf ? root : capture;
        const selected =
          !possibleWrites || readAt === undefined
            ? binding
            : semanticBindingAtRead(binding, readAt, state.parentsByNode)
                .binding;
        const initializers = possibleWrites
          ? [...selected.initializers, ...selected.referenceInitializers]
          : stable === undefined
            ? []
            : [stable];
        for (const initializer of initializers) {
          if (semanticReferenceSourcesInactive(initializer, state)) continue;
          // Pattern assignments share the source selection owner with member
          // effects: copying a container preserves its children, not itself.
          const path = semanticCopiedReferencePath(
            initializer,
            suffix ?? [null],
            escapedContents ? "escape" : "identity",
          );
          if (path === null) continue;
          pending.push({
            node: initializer.node,
            readsAtSelf: true,
            ...(prototypeReadAt === undefined ? {} : { prototypeReadAt }),
            prototypeDepths: shiftPrototypeDepths(
              suffix === undefined
                ? undefined
                : path.map((key) =>
                    key === null || typeof key === "object"
                      ? null
                      : String(key),
                  ),
            ),
            suffix:
              suffix === undefined ||
              semanticReferenceIterationUnknown(initializer, state)
                ? undefined
                : path.map((key) =>
                    key === null || typeof key === "object"
                      ? null
                      : String(key),
                  ),
          });
        }
        continue;
      }
      // Literal instances share native prototypes. A write to the instance's
      // own __proto__ slot changes only that instance; selecting or exposing
      // the prototype's contents can affect every instance of the builtin.
      if (
        possibleWrites &&
        suffix?.[0] === "__proto__" &&
        (escapedContents || selection?.prototypeReceiver || suffix.length > 1)
      ) {
        const builtin = t.isArrayExpression(root)
          ? "Array"
          : t.isObjectExpression(root) &&
              root.properties.every((property) => {
                if (t.isSpreadElement(property))
                  return prototypeDepths.includes(0);
                const key = semanticStaticPropertyKey(
                  property.key,
                  property.computed,
                );
                const prototypeSetter =
                  t.isObjectProperty(property) &&
                  !property.computed &&
                  !property.shorthand &&
                  key === "__proto__";
                if (prototypeSetter && t.isObjectProperty(property)) {
                  const literal = readExactJavaScriptLiteral(property.value);
                  return literal.found && literal.value !== null;
                }
                return (
                  prototypeDepths.includes(0) ||
                  (key !== null && key !== "__proto__")
                );
              })
            ? "Object"
            : undefined;
        if (builtin !== undefined) {
          const ownProtoData =
            t.isObjectExpression(root) &&
            root.properties.some(
              (property) =>
                !t.isSpreadElement(property) &&
                semanticStaticPropertyKey(property.key, property.computed) ===
                  "__proto__" &&
                !(
                  t.isObjectProperty(property) &&
                  !property.computed &&
                  !property.shorthand
                ),
            );
          const replaced =
            !(prototypeDepths.includes(0) && ownProtoData) &&
            [...(facts?.stores.get(root) ?? [])].some(
              ([source, path]) =>
                path?.length === 1 &&
                path[0] === "__proto__" &&
                t.isAssignmentExpression(source.mutation, { operator: "=" }) &&
                source.target !== undefined &&
                facts?.freshObject(source.target.object) &&
                (facts.freshObject(source.node) ||
                  t.isNullLiteral(source.node)) &&
                semanticDefiniteEffectPrecedesReference(
                  source.mutation,
                  prototypeReadAt ?? capture ?? current.node,
                  state.parentsByNode,
                ),
            );
          if (!replaced)
            retain(["global", builtin, "prototype", ...suffix.slice(1)]);
          continue;
        }
      }
      if (
        possibleWrites &&
        t.isNewExpression(root) &&
        (suffix?.[0] === "__proto__" || suffix?.[0] === "constructor")
      ) {
        continueWith(
          root.callee,
          suffix[0] === "__proto__"
            ? ["prototype", ...suffix.slice(1)]
            : suffix.slice(1),
        );
        continue;
      }
      const prototypeTarget = possibleWrites
        ? facts?.prototypeTarget(root)
        : undefined;
      if (prototypeTarget !== undefined) {
        continueWith(
          prototypeTarget,
          suffix === undefined ? undefined : ["__proto__", ...suffix],
          suffix === undefined
            ? []
            : [0, ...prototypeDepths.map((depth) => depth + 1)],
          root,
        );
        continue;
      }
      if (
        possibleWrites &&
        (t.isCallExpression(root) ||
          t.isOptionalCallExpression(root) ||
          t.isNewExpression(root) ||
          t.isTaggedTemplateExpression(root) ||
          (escapedContents && (t.isFunction(root) || t.isClass(root))))
      ) {
        continueReturned(
          t.isFunction(root) || t.isClass(root)
            ? root
            : t.isTaggedTemplateExpression(root)
              ? root.tag
              : root.callee,
          suffix,
        );
        continue;
      }
      if (possibleWrites && t.isConditionalExpression(root)) {
        continueWith(root.consequent);
        continueWith(root.alternate);
        continue;
      }
      if (possibleWrites && t.isLogicalExpression(root)) {
        continueWith(root.left);
        continueWith(root.right);
        continue;
      }
      if (possibleWrites && t.isSequenceExpression(root)) {
        const value = root.expressions.at(-1);
        if (value !== undefined) continueWith(value);
        continue;
      }
      if (
        possibleWrites &&
        t.isAssignmentExpression(root) &&
        root.operator === "="
      ) {
        continueWith(root.right);
        continue;
      }
      const key = suffix?.[0];
      // Container escapes reuse the finite worklist, including alias cycles.
      if (escapedContents && suffix?.length === 0) {
        if (t.isObjectExpression(root)) {
          for (const property of root.properties)
            if (t.isSpreadElement(property))
              // A fresh copy exposes selected children, not its source container.
              continueWith(property.argument, [null]);
            else if (
              t.isObjectProperty(property) &&
              t.isExpression(property.value)
            )
              continueWith(property.value, []);
            else if (t.isObjectMethod(property) && property.kind === "get")
              continueReturned(property, []);
          continue;
        }
        if (t.isArrayExpression(root)) {
          for (const element of root.elements)
            if (t.isSpreadElement(element)) continueWith(element.argument, []);
            else if (t.isExpression(element)) continueWith(element, []);
          continue;
        }
      }
      if (suffix !== undefined && key === undefined) continue;
      if (t.isObjectExpression(root)) {
        if (possibleWrites) {
          for (const property of root.properties) {
            if (t.isSpreadElement(property)) continueWith(property.argument);
            else if (
              (t.isObjectProperty(property) &&
                t.isExpression(property.value)) ||
              (t.isObjectMethod(property) && property.kind === "get")
            ) {
              const ownKey = semanticStaticPropertyKey(
                property.key,
                property.computed,
              );
              if (
                suffix === undefined ||
                key === null ||
                ownKey === null ||
                ownKey === key
              )
                if (t.isObjectMethod(property))
                  continueReturned(property, suffix?.slice(1));
                else if (t.isExpression(property.value))
                  continueWith(property.value, suffix?.slice(1));
            }
          }
        } else if (
          suffix !== undefined &&
          key !== null &&
          root.properties.every(
            (property) =>
              t.isObjectProperty(property) &&
              semanticStaticPropertyKey(property.key, property.computed) !==
                null,
          )
        ) {
          const property = root.properties.findLast(
            (property) =>
              t.isObjectProperty(property) &&
              semanticStaticPropertyKey(property.key, property.computed) ===
                key,
          );
          if (t.isObjectProperty(property) && t.isExpression(property.value))
            continueWith(property.value, suffix.slice(1));
        }
      } else if (t.isArrayExpression(root)) {
        if (suffix === undefined) {
          for (const element of root.elements)
            if (t.isSpreadElement(element)) continueWith(element.argument);
            else if (t.isExpression(element)) continueWith(element);
        } else if (!root.elements.some(t.isSpreadElement)) {
          const index = Number(key);
          if (key === null && possibleWrites) {
            for (const element of root.elements)
              if (t.isExpression(element))
                continueWith(element, suffix.slice(1));
          } else if (
            key !== null &&
            Number.isInteger(index) &&
            index >= 0 &&
            String(index) === key
          ) {
            const element = root.elements[index];
            if (t.isExpression(element)) continueWith(element, suffix.slice(1));
          }
        }
      }
    }
    const paths = [...result.values()];
    if (!possibleWrites) cached.set(node, paths);
    return paths;
  };
};

/**
 * Index source-local writes through ambient identities and stable aliases.
 * The shared invocation owner resolves intrinsic aliases, bind/call/apply and
 * literal argument spreads. Runtime reachability and arbitrary call effects
 * remain unevaluated; a visible possible write is sufficient.
 */
export function* indexJavaScriptAmbientWritesSteps(
  program: t.Program,
  state: JavaScriptSemanticAnalysisState,
  observeOpaqueInvocation?: (node: t.Node) => void,
  observeWriteSite?: (node: t.Node) => void,
): Generator<void> {
  const ambientReads = createAmbientPathResolver(state, false);
  const nativeReceiverCalls: {
    readonly node: t.Node;
    readonly receiver: t.Node;
  }[] = [];
  const storedSites = new WeakSet<t.Node>();
  const storedReferences: SemanticIterationSource[] = [];
  const writes: { node: t.Node; path: AmbientPath }[] = [];
  const targets: { node: t.Node; capture: t.Node }[] = [];
  const escapes: {
    node: t.Node;
    target: t.Node;
    browserReceiver: boolean;
    projection?: AmbientProjection;
  }[] = [];
  const stores = new WeakMap<
    t.Node,
    Map<SemanticIterationSource, AmbientProjection>
  >();
  const interop = createSemanticModuleInterop(state, {
    intrinsicPath: (node) => {
      const [path] = ambientReads(node);
      return path?.[0] === "global" && path.every((key) => key !== null)
        ? ["intrinsic", ...(path.slice(1) as readonly string[])]
        : undefined;
    },
  });
  const ambientWrites = createAmbientPathResolver(state, true, {
    stores,
    freshObject: interop.isFreshObject,
    prototypeTarget: (node) => {
      if (!t.isCallExpression(node) && !t.isOptionalCallExpression(node))
        return undefined;
      const invocation = interop.intrinsicInvocation(node);
      if (
        invocation?.kind !== "known" ||
        invocation.path.length !== 3 ||
        !["Object", "Reflect"].includes(invocation.path[1] ?? "") ||
        invocation.path[2] !== "getPrototypeOf"
      )
        return undefined;
      const target = invocation.arguments?.[0];
      return t.isNode(target) && !t.isSpreadElement(target)
        ? target
        : undefined;
    },
  });
  yield* collectJavaScriptIdentityWritesSteps(
    program,
    (root, kind, writeSite) => {
      if (kind === "opaque-call") return [];
      observeWriteSite?.(writeSite);
      // Reassigning a local alias changes the binding, not the referenced object.
      if (kind === "binding")
        return t.isIdentifier(root) &&
          isUnshadowedGlobal(root, state, root.name)
          ? [["global", root.name]]
          : [];
      if (!storedSites.has(writeSite)) {
        storedSites.add(writeSite);
        for (const source of semanticIterationSources(
          writeSite,
          state.parentsByNode.get(writeSite) ?? null,
        )) {
          if (source.kind === "reference-store") storedReferences.push(source);
        }
      }
      // Resolve identities after the traversal has collected every local store.
      const id = targets.push({ node: root, capture: writeSite }) - 1;
      return [["pending-target", String(id)]];
    },
    interop.intrinsicInvocation,
    interop.staticString,
    interop.isFreshObject,
    (node, path) => {
      writes.push({ node, path });
    },
    (node, invocation) => {
      observeOpaqueInvocation?.(node);
      // Escaping objects can change contents without replacing their identity.
      const retainEscape = (target: t.Node, browserReceiver = false) => {
        escapes.push({ target, node, browserReceiver });
      };
      for (const argument of t.isTaggedTemplateExpression(node)
        ? node.quasi.expressions
        : node.arguments)
        if (t.isNode(argument))
          retainEscape(
            t.isSpreadElement(argument) ? argument.argument : argument,
          );
      const callee = unwrapJavaScriptExpression(
        t.isTaggedTemplateExpression(node) ? node.tag : node.callee,
      ).node;
      const browserMethod =
        invocation?.kind === "known" &&
        invocation.path.length === 2 &&
        ["open", "fetch"].includes(invocation.path[1] ?? "")
          ? invocation.path[1]
          : undefined;
      const member =
        t.isMemberExpression(callee) || t.isOptionalMemberExpression(callee)
          ? callee
          : undefined;
      const receiver = member?.object;
      const [namespace] = receiver === undefined ? [] : ambientReads(receiver);
      const method =
        member === undefined
          ? null
          : semanticStaticPropertyKey(member.property, member.computed);
      const nativeNamespace =
        namespace?.length === 2 &&
        namespace[0] === "global" &&
        (namespace[1] === "Object" || namespace[1] === "Reflect")
          ? namespace[1]
          : undefined;
      const nativeReceiver =
        invocation?.kind === "known" &&
        nativeNamespace !== undefined &&
        method !== null &&
        NATIVE_NAMESPACE_METHODS[nativeNamespace].has(String(method));
      if (nativeReceiver && receiver !== undefined) {
        state.intrinsicReceiverCalls.set(node, [
          "global",
          nativeNamespace!,
          String(method),
        ]);
        nativeReceiverCalls.push({ node, receiver });
      }
      if (
        !t.isNewExpression(node) &&
        (t.isMemberExpression(callee) ||
          t.isOptionalMemberExpression(callee)) &&
        !nativeReceiver
      ) {
        if (browserMethod !== undefined) {
          state.intrinsicReceiverCalls.set(node, ["global", browserMethod]);
          nativeReceiverCalls.push({ node, receiver: callee.object });
        }
        retainEscape(callee.object, browserMethod !== undefined);
      }
    },
  );
  const pendingStores = new Set(storedReferences);
  const dependents = new WeakMap<t.Node, Set<SemanticIterationSource>>();
  while (pendingStores.size > 0) {
    const source = pendingStores.values().next().value;
    if (source === undefined) break;
    pendingStores.delete(source);
    if (source.target === undefined) continue;
    const identities = new Map<t.Node, AmbientProjection>();
    ambientWrites(source.target, source.mutation, false, [], {
      localIdentity: (node, path) => {
        const users =
          dependents.get(node) ?? new Set<SemanticIterationSource>();
        users.add(source);
        dependents.set(node, users);
        identities.set(
          node,
          identities.has(node)
            ? joinAmbientProjection(identities.get(node), path)
            : path,
        );
      },
    });
    // Publish only completed queries; each source/root projection can only widen.
    for (const [node, path] of identities) {
      const entries =
        stores.get(node) ??
        new Map<SemanticIterationSource, AmbientProjection>();
      const previous = entries.get(source);
      const joined = entries.has(source)
        ? joinAmbientProjection(previous, path)
        : path;
      if (
        entries.has(source) &&
        (previous === undefined ||
          (joined !== undefined &&
            previous.every((key, index) => key === joined[index])))
      )
        continue;
      entries.set(source, joined);
      stores.set(node, entries);
      for (const dependent of dependents.get(node) ?? [])
        pendingStores.add(dependent);
    }
    yield;
  }
  for (const source of storedReferences) {
    if (source.target === undefined) continue;
    let local = false;
    const ambient = ambientWrites(
      source.target.object,
      source.mutation,
      false,
      [],
      {
        localIdentity: () => {
          local = true;
        },
      },
    );
    if (!local || ambient.length > 0)
      escapes.push({
        node: source.mutation,
        target: source.node,
        browserReceiver: false,
        projection: source.projection.map((key) =>
          key === null || typeof key === "object" ? null : String(key),
        ),
      });
  }
  for (const { node, path } of writes) {
    const target =
      path[0] === "pending-target" ? targets[Number(path[1])] : undefined;
    const paths =
      target === undefined
        ? [path]
        : ambientWrites(target.node, target.capture, false, [], {
            prototypeReceiver: true,
          }).map((identity) => [...identity, ...path.slice(2)]);
    for (const resolved of paths) {
      retainSemanticAmbientEffect(state, "write", resolved, node);
    }
  }
  for (const { node, target, browserReceiver, projection } of escapes)
    for (const path of ambientWrites(target, node, true, projection))
      // Only proven browser APIs keep their global receiver from user code.
      if (!(browserReceiver && path.length === 1 && path[0] === "global")) {
        retainSemanticAmbientEffect(state, "escape", path, node);
      }
  for (const { node, receiver } of nativeReceiverCalls) {
    if (semanticIntrinsicReceiverIsSafe(node, state)) continue;
    for (const identity of ambientWrites(receiver, node, true))
      retainSemanticAmbientEffect(state, "escape", identity, node);
  }
}

/**
 * Recognize an ambient property path, optionally through a global object, without a visible
 * source-local overwrite. This is a syntax-local identity fact, not proof that
 * the runtime's globals have never been patched by other code.
 */
export const isUnmodifiedGlobalReference = (
  callee: t.Node,
  state: JavaScriptSemanticAnalysisState,
  name: string | readonly [string, ...string[]],
): boolean => {
  const path: readonly [string, ...string[]] =
    typeof name === "string" ? [name] : name;
  if (state.ambientWrites.covers(["global", ...path])) return false;
  const { root, members } = electronMemberPath(callee);
  const matches = (expected: readonly string[]) =>
    members.length === expected.length &&
    members.every((key, index) => key === expected[index]);
  if (isUnshadowedGlobal(root, state, path[0]) && matches(path.slice(1)))
    return true;
  const namespace = globalObjectName(root, state);
  return (
    namespace !== undefined &&
    matches(path) &&
    !state.ambientWrites.covers(["global", namespace])
  );
};

/** A module URL base is known only while its property has no visible write. */
export const isUnmodifiedImportMetaUrl = (
  node: t.Node | undefined,
  state: JavaScriptSemanticAnalysisState,
): boolean =>
  isImportMetaUrl(node) && !state.ambientWrites.covers(["import-meta", "url"]);
