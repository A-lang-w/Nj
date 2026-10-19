import * as t from "@babel/types";
import {
  readExactJavaScriptNormalResult,
  semanticDirectFunctionReturn,
  semanticStaticPropertyKey,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";
import {
  isUnshadowedGlobal,
  type JavaScriptSemanticAnalysisState,
} from "./javascriptSemanticState.js";
import {
  syntaxEvaluationAlwaysThrows,
  syntaxAlwaysThrows,
  syntaxEvaluationCannotThrow,
} from "./javascriptSymbolicControlFlow.js";

export type JavaScriptResourceAcquisition = "acquired" | "failed" | "unknown";

interface AsyncResourceRegistration {
  readonly status: JavaScriptResourceAcquisition;
  readonly disposer?: t.Function;
  readonly synchronous?: boolean;
}

/** Registration captures a callable disposer; evaluating an object is not registration. */
const asyncResourceRegistration = (
  raw: t.Node,
  state: JavaScriptSemanticAnalysisState,
): AsyncResourceRegistration => {
  if (syntaxEvaluationAlwaysThrows(raw)) return { status: "failed" };
  const node = unwrapJavaScriptExpression(raw).node;
  const normal = readExactJavaScriptNormalResult(
    node,
    syntaxEvaluationCannotThrow,
  );
  if (normal.found)
    return { status: normal.value == null ? "acquired" : "failed" };
  if (isUnshadowedGlobal(node, state, "undefined"))
    return { status: "acquired" };
  if (t.isBigIntLiteral(node)) return { status: "failed" };
  if (!t.isObjectExpression(node)) return { status: "unknown" };
  // These proofs depend on collected intrinsic/prototype effects. An index
  // still being produced is not proof that the relevant effects are absent.
  state.memberMutationFactsPhase ??= "requested";
  if (state.memberMutationFactsPhase !== "indexed")
    return { status: "unknown" };
  let prototype: "default" | "null" | "unknown" = "default";
  const disposers = new Map<string, t.ObjectProperty | t.ObjectMethod>();
  for (const property of node.properties) {
    if (t.isSpreadElement(property)) return { status: "unknown" };
    const key = unwrapJavaScriptExpression(property.key).node;
    const symbol =
      property.computed &&
      t.isMemberExpression(key) &&
      !key.computed &&
      t.isIdentifier(key.property) &&
      ["asyncDispose", "dispose"].includes(key.property.name) &&
      isUnshadowedGlobal(key.object, state, "Symbol") &&
      !state.ambientWrites.covers(["global", "Symbol", key.property.name]) &&
      !state.ambientEscapes.covers(["global", "Symbol", key.property.name]);
    if (!symbol && semanticStaticPropertyKey(key, property.computed) === null)
      return { status: "unknown" };
    if (
      t.isObjectProperty(property) &&
      !syntaxEvaluationCannotThrow(property.value)
    )
      return { status: "unknown" };
    if (symbol && t.isMemberExpression(key) && t.isIdentifier(key.property))
      disposers.set(key.property.name, property);
    if (
      !property.computed &&
      t.isObjectProperty(property) &&
      !property.shorthand &&
      semanticStaticPropertyKey(key, false) === "__proto__"
    )
      prototype = t.isNullLiteral(property.value) ? "null" : "unknown";
  }
  const inheritedUnknown =
    prototype === "unknown" ||
    (prototype === "default" &&
      (state.ambientWrites.covers(["global", "Object", "prototype", null]) ||
        state.ambientEscapes.covers(["global", "Object", "prototype", null])));
  for (const name of ["asyncDispose", "dispose"]) {
    const method = disposers.get(name);
    if (method === undefined) {
      if (inheritedUnknown) return { status: "unknown" };
      continue;
    }
    if (t.isObjectMethod(method))
      return method.kind === "method"
        ? {
            status: "acquired",
            disposer: method,
            synchronous: name === "dispose",
          }
        : { status: "unknown" };
    const value = unwrapJavaScriptExpression(method.value).node;
    if (t.isFunctionExpression(value) || t.isArrowFunctionExpression(value))
      return {
        status: "acquired",
        disposer: value,
        synchronous: name === "dispose",
      };
    const result = readExactJavaScriptNormalResult(
      value,
      syntaxEvaluationCannotThrow,
    );
    if (!result.found) return { status: "unknown" };
    if (result.value != null) return { status: "failed" };
  }
  return { status: "failed" };
};

/** Earlier acquired resources survive a later initializer or acquisition failure. */
export const semanticAsyncDeclarationAcquisition = (
  declaration: t.VariableDeclaration,
  state: JavaScriptSemanticAnalysisState,
): JavaScriptResourceAcquisition => {
  // The first registration either contributes a disposal resource, fails
  // before all later declarators, or leaves their applicability unknown.
  const initializer = declaration.declarations[0]?.init;
  return initializer == null
    ? "unknown"
    : asyncResourceRegistration(initializer, state).status;
};

/** Acquiring a method and reaching its disposal await are separate facts. */
export const semanticAsyncDeclarationDisposal = (
  declaration: t.VariableDeclaration,
  state: JavaScriptSemanticAnalysisState,
): "wait" | "abrupt" | "unknown" => {
  const initializer = declaration.declarations[0]?.init;
  if (initializer == null) return "unknown";
  const registration = asyncResourceRegistration(initializer, state);
  if (registration.status !== "acquired")
    return registration.status === "failed" ? "abrupt" : "unknown";
  const method = registration.disposer;
  // Async-from-sync disposal catches a synchronous failure into a rejected
  // promise; a directly registered asyncDispose method can throw before await.
  if (
    method === undefined ||
    registration.synchronous ||
    (method.async && !method.generator)
  )
    return "wait";
  // Ordinary and generator methods initialize parameters during Call, before
  // producing a value to await. Non-generator async methods reject a promise.
  if (
    method.params.some(
      (parameter) =>
        t.isObjectPattern(parameter) ||
        t.isArrayPattern(parameter) ||
        (t.isAssignmentPattern(parameter) &&
          syntaxEvaluationAlwaysThrows(parameter.right)),
    )
  )
    return "abrupt";
  if (
    !method.params.every(
      (parameter) =>
        t.isIdentifier(parameter) ||
        (t.isRestElement(parameter) && t.isIdentifier(parameter.argument)) ||
        (t.isAssignmentPattern(parameter) &&
          t.isIdentifier(parameter.left) &&
          syntaxEvaluationCannotThrow(parameter.right)),
    )
  )
    return "unknown";
  if (method.generator) return "wait";
  if (syntaxAlwaysThrows(method.body)) return "abrupt";
  const returned = semanticDirectFunctionReturn(method);
  return syntaxEvaluationCannotThrow(method.body) ||
    (t.isBlockStatement(method.body) &&
      method.body.body.every((statement) =>
        t.isReturnStatement(statement)
          ? statement.argument == null ||
            syntaxEvaluationCannotThrow(statement.argument)
          : syntaxEvaluationCannotThrow(statement),
      )) ||
    (returned !== undefined && syntaxEvaluationCannotThrow(returned))
    ? "wait"
    : "unknown";
};
