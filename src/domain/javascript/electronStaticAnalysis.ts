import * as t from "@babel/types";

import { inspectElectronBrowserNode } from "./electronStaticAnalysisBrowser.js";
import { inspectElectronIpcNode } from "./electronStaticAnalysisIpc.js";
import { inspectElectronNativeNode } from "./electronStaticAnalysisNative.js";
import type { JavaScriptFindingContext } from "./javascriptStaticAnalysisState.js";
import { electronCalleePath } from "./electronStaticAnalysisValues.js";
import { addLocatedFinding } from "./javascriptStaticAnalysisFindings.js";
import { range } from "./javascriptStaticAnalysisHelpers.js";

/** Collect Electron-specific syntax during the shared inert AST traversal. */
export const inspectElectronStaticNode = (
  node: t.Node,
  context: JavaScriptFindingContext,
): void => {
  inspectElectronBrowserNode(node, context);
  inspectElectronIpcNode(node, context);
  inspectElectronNativeNode(node, context);
  if (!t.isCallExpression(node) && !t.isOptionalCallExpression(node)) return;
  const path = electronCalleePath(node.callee, context);
  if (path?.length === 2 && path[0] === "app" && path[1] === "setAppPath")
    addLocatedFinding(context, {
      collection: context.accumulator.appPathChanges,
      key: "electron:app-path-change",
      node,
      value: { module_key: null, location: range(node) },
    });
};
