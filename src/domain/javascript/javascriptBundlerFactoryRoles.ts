import * as t from "@babel/types";

import {
  runtimeFunctionParameters,
  semanticStaticPropertyKey,
} from "./javascriptAstValues.js";

/** Calling-convention roles bound once from one bundler factory's parameters. */
export interface JavaScriptBundlerFactoryRoles {
  /** The parameter bound to the module object. */
  readonly module: t.Identifier | undefined;
  /** Every parameter binding whose entry value is `module.exports`. */
  readonly exports: readonly t.Identifier[];
  /** The parameter bound to the bundler loader (`__webpack_require__`). */
  readonly loader: t.Identifier | undefined;
  /**
   * Default expressions of the module and exports parameters. The calling
   * convention always supplies both objects, so these defaults never run.
   */
  readonly unusedDefaults: ReadonlySet<t.Node>;
  /**
   * False when a role parameter uses a pattern whose bindings cannot be
   * matched exactly, such as a rest element or a computed or nested key.
   * Facts read through the roles are then incomplete, not absent.
   */
  readonly exact: boolean;
}

type FactoryRole = "module" | "exports" | "loader";

/** Positional factory roles of a recognized bundler runtime. */
const roleOrder = (runtime: string): readonly FactoryRole[] =>
  runtime === "esbuild-commonjs"
    ? ["exports", "module"]
    : runtime.startsWith("esbuild-")
      ? []
      : ["module", "exports", "loader"];

/** Bind a factory's role parameters by position, never by spelling. */
export const javascriptBundlerFactoryRoles = (
  factory: t.Function,
  runtime: string,
): JavaScriptBundlerFactoryRoles => {
  const parameters = runtimeFunctionParameters(factory);
  const roles: {
    module: t.Identifier | undefined;
    exports: t.Identifier[];
    loader: t.Identifier | undefined;
  } = { module: undefined, exports: [], loader: undefined };
  const unusedDefaults = new Set<t.Node>();
  let exact = true;
  const bindingIdentifier = (node: t.Node): t.Identifier | undefined => {
    if (t.isIdentifier(node)) return node;
    if (t.isAssignmentPattern(node) && t.isIdentifier(node.left)) {
      unusedDefaults.add(node.right);
      return node.left;
    }
    return undefined;
  };
  for (const [index, role] of roleOrder(runtime).entries()) {
    const parameter = parameters[index];
    if (parameter === undefined) break;
    // A rest element collects this and every later argument into an array.
    if (t.isRestElement(parameter)) {
      exact = false;
      break;
    }
    // Loader consumers resolve its calls through the binding's own value
    // facts, which cannot yet discount a default the convention never runs.
    const identifier =
      role === "loader"
        ? t.isIdentifier(parameter)
          ? parameter
          : undefined
        : bindingIdentifier(parameter);
    if (identifier !== undefined) {
      // A repeated simple parameter name binds its last argument.
      if (boundLater(parameters, index, identifier.name)) continue;
      if (role === "exports") roles.exports.push(identifier);
      else roles[role] = identifier;
      continue;
    }
    const pattern = t.isAssignmentPattern(parameter)
      ? parameter.left
      : parameter;
    if (role === "module" && t.isObjectPattern(pattern)) {
      if (t.isAssignmentPattern(parameter)) unusedDefaults.add(parameter.right);
      if (!moduleExportsAliases(pattern, bindingIdentifier, roles.exports))
        exact = false;
      continue;
    }
    exact = false;
  }
  return { ...roles, unusedDefaults, exact };
};

/** `{exports: alias}` binds `module.exports`; other static keys cannot reach it. */
const moduleExportsAliases = (
  pattern: t.ObjectPattern,
  bindingIdentifier: (node: t.Node) => t.Identifier | undefined,
  output: t.Identifier[],
): boolean => {
  for (const property of pattern.properties) {
    // A shallow rest copy keeps the `exports` property's object.
    if (t.isRestElement(property)) return false;
    const key = semanticStaticPropertyKey(property.key, property.computed);
    if (key === null) return false;
    if (key !== "exports") continue;
    const alias = bindingIdentifier(property.value);
    if (alias === undefined) return false;
    output.push(alias);
  }
  return true;
};

const boundLater = (
  parameters: t.Function["params"],
  index: number,
  name: string,
): boolean =>
  parameters
    .slice(index + 1)
    .some((parameter) =>
      Object.hasOwn(t.getBindingIdentifiers(parameter), name),
    );
