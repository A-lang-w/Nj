import * as t from "@babel/types";

import { electronCalleePath } from "./electronStaticAnalysisValues.js";
import {
  semanticStaticPropertyKey,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";
import { semanticBindingAtRead } from "./javascriptSemanticMutationInitializers.js";
import {
  semanticStableInitializer,
  type JavaScriptBindingIndex,
} from "./javascriptSemanticState.js";
import { completeSemanticSteps } from "./javascriptSemanticTraversal.js";
import type { JavaScriptFindingContext } from "./javascriptStaticAnalysisState.js";

/** A renderer load belongs to an intact, source-proven BrowserWindow instance. */
export const isElectronRendererLoad = (
  callee: t.Node,
  site: t.Node,
  context: JavaScriptFindingContext,
  index: JavaScriptBindingIndex,
): boolean => {
  callee = unwrapJavaScriptExpression(callee).node;
  if (!t.isMemberExpression(callee) && !t.isOptionalMemberExpression(callee))
    return false;
  const method = semanticStaticPropertyKey(callee.property, callee.computed);
  if (method !== "loadFile" && method !== "loadURL") return false;
  const receiver = resolveElectronBrowserWindowReceiver(
    callee.object,
    site,
    [method],
    context,
    index,
  );
  return (
    receiver !== undefined &&
    (receiver.path.length === 1 ||
      (receiver.path.length === 2 && receiver.path[0] === "webContents"))
  );
};

/** Source allocation identity, not a claim about runtime window/frame identity. */
export const resolveElectronBrowserWindowReceiver = (
  node: t.Node,
  site: t.Node,
  suffix: readonly string[],
  context: JavaScriptFindingContext,
  index: JavaScriptBindingIndex,
):
  | { readonly owner: t.NewExpression; readonly path: readonly string[] }
  | undefined => {
  let receiver = unwrapJavaScriptExpression(node).node;
  const path = [...suffix];
  const seen = new Set<string>();
  for (;;) {
    if (
      t.isMemberExpression(receiver) ||
      t.isOptionalMemberExpression(receiver)
    ) {
      const member = semanticStaticPropertyKey(
        receiver.property,
        receiver.computed,
      );
      if (member === null) return undefined;
      path.unshift(member);
      receiver = unwrapJavaScriptExpression(receiver.object).node;
      continue;
    }
    if (!t.isIdentifier(receiver)) break;
    const binding = index.bindingForReferenceAt(receiver);
    if (binding === undefined || seen.has(binding.bindingId)) return undefined;
    seen.add(binding.bindingId);
    const initializer = semanticStableInitializer(binding, index.bindings);
    if (
      initializer === undefined ||
      initializer.projection.length !== 0 ||
      !semanticBindingAtRead(binding, receiver, index.bindings.parentsByNode)
        .hasDefiniteInitializer
    )
      return undefined;
    completeSemanticSteps(index.indexMemberMutationFactsSteps());
    if (index.referenceMayHaveChangedAt(site, receiver, path)) return undefined;
    receiver = unwrapJavaScriptExpression(initializer.node).node;
  }
  if (!t.isNewExpression(receiver)) return undefined;
  const constructor = electronCalleePath(receiver.callee, context);
  return constructor?.length === 1 &&
    constructor[0] === "BrowserWindow" &&
    context.electronExportIntact?.([
      "electron",
      "BrowserWindow",
      "prototype",
      ...path,
    ]) === true
    ? { owner: receiver, path }
    : undefined;
};
