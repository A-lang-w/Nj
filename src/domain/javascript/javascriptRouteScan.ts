import * as t from "@babel/types";
import { jsonValueByteLength } from "../jsonValueByteLength.js";
import type { JsonValue } from "../jsonValue.js";
import { JAVASCRIPT_STATIC_FACT_BYTES } from "./javascriptAnalysisResourceControls.js";
import {
  semanticStaticPropertyName,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";
import {
  calleeName,
  range as sourceRange,
  STATIC_ROUTE_CALL_NAMES,
  stringValue,
} from "./javascriptStaticAnalysisHelpers.js";
import {
  semanticStableInitializer,
  type JavaScriptBindingIndex,
} from "./javascriptSemanticState.js";
import { nextAppRoutePath, routePath } from "./javascriptRoutePaths.js";
import type {
  JavaScriptRouteCandidate,
  JavaScriptRouteSegment,
  JavaScriptRouteSourceFacts,
} from "./javascriptRouteFacts.js";

// Copy the parser interface into the JSON fact representation at its owner.
const range = (node: t.Node): JavaScriptRouteSegment["location"] => {
  const value = sourceRange(node);
  return { start: { ...value.start }, end: { ...value.end } };
};

type Mechanism = JavaScriptRouteCandidate["mechanism"];
type LegacyRoute = { node: t.Node; value: string; mechanism: string };
interface SegmentLink {
  readonly previous: SegmentLink | null;
  readonly segment: JavaScriptRouteSegment;
  readonly inferred: boolean;
}
interface Ancestry {
  readonly node: t.Node;
  readonly previous: Ancestry | undefined;
}
interface Frame {
  readonly node: t.Node;
  readonly parent: SegmentLink | null;
  readonly ancestry?: Ancestry;
  readonly fallback?: { key: string; node: t.Node };
}
interface Fields {
  readonly values: ReadonlyMap<string, t.ObjectProperty>;
  readonly unknownKeys: boolean;
  readonly dynamicNames: ReadonlySet<string>;
}
const structuredCalls = new Set([
  "useRoutes",
  "createBrowserRouter",
  "createHashRouter",
  "defineRoutes",
  "createRoutes",
]);
const navigationCalls = new Set([
  "push",
  "replace",
  "prefetch",
  "navigate",
  "href",
]);
const nextNames = new Set(["TURBOPACK", "webpackChunk_N_E", "__NEXT_DATA__"]);

/** Shared syntax owner; both consumers borrow their existing AST walk and lexical index. */
export class JavaScriptRouteScan {
  readonly #result: JavaScriptRouteSourceFacts = {
    candidates: [],
    unresolved: [],
    capacity: null,
  };
  readonly #calls: {
    node: t.CallExpression | t.OptionalCallExpression;
    typed: boolean;
  }[] = [];
  readonly #automaticRoots: { node: t.ObjectExpression; typed: boolean }[] = [];
  readonly #expanded = new WeakSet<t.Node>();
  readonly #seen = new Set<string>();
  readonly #literalPaths: { value: string; node: t.Node }[] = [];
  readonly #propertyValues = new WeakSet<t.Node>();
  readonly #fieldsCache = new WeakMap<t.ObjectExpression, Fields>();
  readonly #objectParents = new WeakMap<
    t.ObjectExpression,
    t.ObjectExpression
  >();
  #nextRuntime = false;
  #factBytes: number;
  #workBytes = 0;

  constructor(
    readonly onLegacyRoute?: (fact: LegacyRoute) => void,
    readonly factByteBudget = JAVASCRIPT_STATIC_FACT_BYTES,
  ) {
    this.#factBytes = jsonValueByteLength({
      candidates: [],
      unresolved: [],
      capacity: {
        kind: "route-work-or-facts",
        limit_bytes: factByteBudget,
        accounted_fact_bytes: factByteBudget,
        accounted_work_bytes: factByteBudget,
      },
    });
    if (
      !Number.isSafeInteger(factByteBudget) ||
      factByteBudget < this.#factBytes
    )
      throw new RangeError(
        "Route accounting budget must fit its coverage metadata",
      );
  }

  inspect(node: t.Node): void {
    // Legacy projections receive the same owned literal observations even when the new facet is full.
    if (t.isObjectProperty(node)) {
      this.#property(node);
      return;
    }
    if (
      t.isCallExpression(node) ||
      t.isOptionalCallExpression(node) ||
      t.isNewExpression(node)
    ) {
      this.#call(node);
      return;
    }
    if (this.#result.capacity !== null) return;
    if (!this.#nextRuntime && t.isIdentifier(node) && nextNames.has(node.name))
      this.#nextRuntime = true;
    if (t.isStringLiteral(node) || t.isTemplateLiteral(node)) {
      const value = stringValue(node);
      if (value === undefined) return;
      const next = nextAppRoutePath(value);
      if (next !== undefined)
        this.#emit(
          next,
          "next-app-chunk",
          [{ value, location: range(node), origin: "next-app-path" }],
          node,
          false,
        );
      if (
        !this.#propertyValues.has(node) &&
        routePath(value) !== undefined &&
        this.#queue(node, value)
      )
        this.#literalPaths.push({ value, node });
    } else if (t.isObjectExpression(node)) this.#object(node);
  }

  #property(node: t.ObjectProperty): void {
    const name = semanticStaticPropertyName(node.key, node.computed);
    if (name === "path" || name === "route") {
      const value = stringValue(node.value);
      if (value !== undefined)
        this.onLegacyRoute?.({ node, value, mechanism: `property:${name}` });
      if (this.#result.capacity === null) this.#propertyValues.add(node.value);
    }
    if (this.#result.capacity === null && name === "href")
      this.#navigation(node.value);
  }

  #call(
    node: t.CallExpression | t.OptionalCallExpression | t.NewExpression,
  ): void {
    const fullName = calleeName(node.callee),
      name = fullName.split(".").at(-1)!;
    const first = node.arguments[0];
    const legacy = STATIC_ROUTE_CALL_NAMES.some(
      (candidate) => candidate === name,
    );
    if (legacy && first !== undefined) {
      const value = stringValue(first);
      if (value !== undefined)
        this.onLegacyRoute?.({ node, value, mechanism: `call:${fullName}` });
    }
    if (this.#result.capacity !== null || t.isNewExpression(node)) return;
    if (structuredCalls.has(name)) {
      if (this.#queue(node))
        this.#calls.push({
          node,
          typed: name === "defineRoutes" || name === "createRoutes",
        });
      return;
    }
    if (
      first === undefined ||
      t.isSpreadElement(first) ||
      t.isArgumentPlaceholder(first)
    )
      return;
    if (navigationCalls.has(name)) this.#navigation(first);
    if (name === "route" || name === "addRoute") {
      const value = stringValue(first),
        path =
          value === undefined
            ? undefined
            : routePath(value, { relative: true });
      if (path !== undefined)
        this.#emit(
          path,
          "router-call",
          [{ value: value!, location: range(first), origin: "literal" }],
          first,
          !value!.startsWith("/"),
        );
      else
        this.#unknown(
          "router-call",
          first,
          "The registered path is not a supported literal.",
        );
    }
  }

  #object(node: t.ObjectExpression): void {
    let typed = false,
      hasPath = false,
      hasChildren = false,
      hasView = false,
      hasIndex = false;
    for (const property of node.properties) {
      if (this.#result.capacity !== null) break;
      if (!t.isObjectProperty(property)) continue;
      const key = semanticStaticPropertyName(property.key, property.computed);
      typed ||= key === "_$";
      hasPath ||= key === "path" || key === "route";
      hasChildren ||= key === "children";
      hasView ||=
        key === "element" || key === "Component" || key === "component";
      hasIndex ||= key === "index";
      const parent = (child: t.ObjectExpression): void => {
        if (this.#queue(child)) this.#objectParents.set(child, node);
      };
      if (t.isObjectExpression(property.value)) parent(property.value);
      else if (t.isArrayExpression(property.value))
        for (const child of property.value.elements) {
          if (this.#result.capacity !== null) break;
          if (t.isObjectExpression(child)) parent(child);
        }
    }
    if (
      (typed || (hasView && (hasPath || hasChildren || hasIndex))) &&
      this.#queue(node)
    )
      this.#automaticRoots.push({ node, typed });
  }

  *finishSteps(
    index: JavaScriptBindingIndex,
  ): Generator<void, JavaScriptRouteSourceFacts> {
    if (this.#result.capacity !== null) return this.#result;
    if (this.#calls.length > 0 || this.#automaticRoots.length > 0)
      yield* index.indexMemberMutationFactsSteps();
    for (const call of this.#calls) {
      if (this.#result.capacity !== null) break;
      yield;
      const first = call.node.arguments[0];
      if (
        first === undefined ||
        t.isSpreadElement(first) ||
        t.isArgumentPlaceholder(first)
      ) {
        this.#unknown(
          call.typed ? "typed-route-tree" : "nested-route-object",
          call.node,
          "The route configuration is unavailable.",
        );
        continue;
      }
      yield* this.#walk(first, call.node, call.typed, index);
    }
    for (const candidate of this.#automaticRoots) {
      if (this.#result.capacity !== null) break;
      yield;
      let root = candidate.node,
        owned = this.#expanded.has(root);
      while (!owned) {
        const parent = this.#objectParents.get(root);
        if (parent === undefined) break;
        root = parent;
        owned = this.#expanded.has(root);
      }
      if (!owned) {
        this.#unknown(
          candidate.typed ? "typed-route-tree" : "nested-route-object",
          root,
          "The routing root is inferred from configuration syntax without a bound route-builder call.",
        );
        yield* this.#walk(root, root, candidate.typed, index, true);
      }
    }
    const roots = new Set(
      this.#result.candidates
        .map(({ path }) => path.split("/")[1])
        .filter(Boolean),
    );
    for (const literal of this.#literalPaths) {
      if (this.#result.capacity !== null) break;
      yield;
      const path = routePath(literal.value, { navigation: true });
      if (
        path === undefined ||
        /^\/(?:_next|api|assets|static)(?:\/|$)/u.test(path)
      )
        continue;
      // These remain inferred candidates. The inventory owner additionally binds them to app roots across sources.
      if (this.#nextRuntime || roots.has(path.split("/")[1]!))
        this.#emit(
          path,
          "route-string-constant",
          [
            {
              value: literal.value,
              location: range(literal.node),
              origin: "literal",
            },
          ],
          literal.node,
          true,
        );
    }
    return this.#result;
  }

  #navigation(node: t.Node): void {
    const value = stringValue(node),
      path =
        value === undefined
          ? undefined
          : routePath(value, { navigation: true });
    if (path !== undefined)
      this.#emit(
        path,
        "navigation-target",
        [{ value: value!, location: range(node), origin: "literal" }],
        node,
        true,
      );
  }

  #fields(node: t.ObjectExpression): Fields {
    const cached = this.#fieldsCache.get(node);
    if (cached !== undefined) return cached;
    const values = new Map<string, t.ObjectProperty>(),
      dynamicNames = new Set<string>();
    let unknownKeys = false;
    for (const property of node.properties) {
      if (!this.#queue(property)) {
        unknownKeys = true;
        break;
      }
      if (t.isSpreadElement(property)) {
        values.clear();
        dynamicNames.clear();
        unknownKeys = true;
        continue;
      }
      const key = semanticStaticPropertyName(property.key, property.computed);
      if (key === undefined) {
        values.clear();
        dynamicNames.clear();
        unknownKeys = true;
      } else if (t.isObjectProperty(property)) {
        values.set(key, property);
        dynamicNames.delete(key);
      } else {
        values.delete(key);
        dynamicNames.add(key);
      }
    }
    const parsed = { values, dynamicNames, unknownKeys };
    this.#fieldsCache.set(node, parsed);
    return parsed;
  }

  #resolve(
    node: t.Node,
    site: t.Node,
    index: JavaScriptBindingIndex,
  ): t.Node | undefined {
    const seen = new Set<t.Node>();
    for (;;) {
      node = unwrapJavaScriptExpression(node).node;
      if (!t.isIdentifier(node)) return node;
      if (seen.has(node)) return;
      seen.add(node);
      const initializer = semanticStableInitializer(
        index.bindingForReferenceAt(node),
        index.bindings,
      );
      if (
        initializer === undefined ||
        initializer.projection.length !== 0 ||
        index.referenceMayHaveChangedAt(site, node)
      )
        return;
      node = initializer.node;
    }
  }

  *#walk(
    root: t.Node,
    site: t.Node,
    typed: boolean,
    index: JavaScriptBindingIndex,
    inferredRoot = false,
  ): Generator<void> {
    const mechanism = typed ? "typed-route-tree" : "nested-route-object",
      frames: Frame[] = [];
    this.#frame(frames, { node: root, parent: null });
    while (frames.length > 0 && this.#result.capacity === null) {
      yield;
      const frame = frames.pop()!,
        node = this.#resolve(frame.node, site, index);
      if (node === undefined) {
        this.#unknown(
          mechanism,
          frame.node,
          "The route configuration may be dynamic, mutated, projected or cyclic.",
        );
        continue;
      }
      let cyclic = false;
      for (
        let parent = frame.ancestry;
        parent !== undefined;
        parent = parent.previous
      )
        if (parent.node === node) {
          cyclic = true;
          break;
        }
      if (cyclic) {
        this.#unknown(
          mechanism,
          frame.node,
          "A cyclic route relationship cannot establish a finite whole path.",
        );
        continue;
      }
      this.#expanded.add(node);
      const ancestry = { node, previous: frame.ancestry };
      if (t.isArrayExpression(node)) {
        for (
          let at = node.elements.length - 1;
          at >= 0 && this.#result.capacity === null;
          at--
        ) {
          const child = node.elements[at];
          if (child !== null && child !== undefined)
            this.#frame(frames, {
              node: child,
              parent: frame.parent,
              ancestry,
            });
        }
        continue;
      }
      if (!t.isObjectExpression(node)) {
        this.#unknown(
          mechanism,
          node,
          "A route configuration is not a static object or array.",
        );
        continue;
      }
      const fields = this.#fields(node);
      if (this.#result.capacity !== null) break;
      const own = fields.values,
        property =
          own.get(typed ? "_$" : "path") ??
          (typed ? undefined : own.get("route"));
      const uncertain =
        fields.unknownKeys ||
        [...fields.dynamicNames].some(
          (key) =>
            typed || key === "path" || key === "route" || key === "children",
        );
      if (uncertain) {
        this.#unknown(
          mechanism,
          node,
          "Spread, computed keys or accessors leave route fields partially unknown.",
        );
        if (property === undefined) continue;
      }
      let link = frame.parent,
        emit = property !== undefined;
      if (property !== undefined) {
        const value = stringValue(property.value);
        if (
          value === undefined ||
          (value !== "" && routePath(value, { relative: true }) === undefined)
        ) {
          this.#unknown(
            mechanism,
            property.value,
            "The parent segment is unknown; descendant full paths are not inferred.",
          );
          continue;
        }
        link = {
          previous: value.startsWith("/") ? null : link,
          segment: {
            value,
            location: range(property.value),
            origin: "literal",
          },
          inferred: false,
        };
      } else if (typed && frame.fallback !== undefined) {
        link = {
          previous: link,
          segment: {
            value: frame.fallback.key,
            location: range(frame.fallback.node),
            origin: "property-name",
          },
          inferred: true,
        };
        emit = true;
      } else if (!typed) {
        const value = own.get("index")?.value;
        emit = t.isBooleanLiteral(value) && value.value;
      }
      if (emit) {
        const segments: JavaScriptRouteSegment[] = [];
        let inferred = inferredRoot;
        for (let part = link; part !== null; part = part.previous) {
          segments.push(part.segment);
          inferred ||= part.inferred;
        }
        segments.reverse();
        const minimumBytes = segments.reduce(
          (bytes, segment) => bytes + Buffer.byteLength(segment.value) + 1,
          0,
        );
        if (minimumBytes > this.#remaining()) {
          this.#capacity();
          break;
        }
        let path = "";
        for (const { value } of segments) {
          if (value === "") continue;
          path =
            path === ""
              ? value.startsWith("/")
                ? value
                : `/${value}`
              : `${path}${path.endsWith("/") ? "" : "/"}${value}`;
        }
        this.#emit(
          path || "/",
          mechanism,
          segments,
          property?.value ?? node,
          inferred,
        );
      }
      if (typed) {
        const entries = [...own.entries()];
        for (
          let at = entries.length - 1;
          at >= 0 && this.#result.capacity === null;
          at--
        ) {
          const [key, child] = entries[at]!;
          if (key.startsWith("_") || key.startsWith("$")) continue;
          if (t.isObjectExpression(child.value) || t.isIdentifier(child.value))
            this.#frame(frames, {
              node: child.value,
              parent: link,
              ancestry,
              fallback: { key, node: child.key },
            });
        }
      } else {
        const children = own.get("children");
        if (children !== undefined)
          this.#frame(frames, { node: children.value, parent: link, ancestry });
      }
    }
  }

  #unknown(mechanism: Mechanism, node: t.Node, reason: string): void {
    const fact = { mechanism, location: range(node), reason };
    if (this.#reserve("fact", fact)) this.#result.unresolved.push(fact);
  }
  #emit(
    path: string,
    mechanism: Mechanism,
    segments: JavaScriptRouteSegment[],
    node: t.Node,
    inferred: boolean,
  ): void {
    if (this.#result.capacity !== null) return;
    if (Buffer.byteLength(path) > this.#remaining()) {
      this.#capacity();
      return;
    }
    const fact: JavaScriptRouteCandidate = {
      path,
      mechanism,
      segments,
      location: range(node),
      confidence: inferred ? "low" : "medium",
      derivation: inferred
        ? "inferred"
        : segments.length === 1 && segments[0]!.value === path
          ? "literal"
          : "joined",
    };
    const key = JSON.stringify([path, mechanism, node.start, node.end]);
    if (this.#seen.has(key)) return;
    if (this.#reserve("fact", fact)) {
      this.#seen.add(key);
      this.#result.candidates.push(fact);
    }
  }
  #remaining(): number {
    return this.factByteBudget - this.#factBytes - this.#workBytes;
  }
  #capacity(): void {
    this.#result.capacity ??= {
      kind: "route-work-or-facts",
      limit_bytes: this.factByteBudget,
      accounted_fact_bytes: this.#factBytes,
      accounted_work_bytes: this.#workBytes,
    };
  }
  #reserve(kind: "fact" | "work", value: JsonValue): boolean {
    if (this.#result.capacity !== null) return false;
    const bytes = jsonValueByteLength(value, this.#remaining()) + 1;
    if (bytes > this.#remaining()) {
      this.#capacity();
      return false;
    }
    if (kind === "fact") this.#factBytes += bytes;
    else this.#workBytes += bytes;
    return true;
  }
  #queue(node: t.Node, value: string | null = null): boolean {
    return this.#reserve("work", { location: range(node), value });
  }
  #frame(frames: Frame[], frame: Frame): void {
    if (this.#queue(frame.node)) frames.push(frame);
  }
}
