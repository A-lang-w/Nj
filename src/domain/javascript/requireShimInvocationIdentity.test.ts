import { describe, expect, it } from "vitest";

import { analyzeParsedJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";
import { analyzeJavaScriptSemantics } from "./javascriptSemanticAnalysis.js";
import { parseJavaScriptSource } from "./javascriptSourceParser.js";

const SHIM = 'var Q=(e=>typeof require<"u"?require:e)(function(){});';

const windows = (source: string, path = "bundle.cjs") => {
  const file = parseJavaScriptSource(source, path);
  expect(file).not.toBeNull();
  return analyzeParsedJavaScriptStaticSource(source, file!).electron
    .browser_windows;
};

describe("proven require shim invocation identity", () => {
  it.each([
    'Q.call(null,"electron")',
    'Q.apply(null,["electron"])',
    'Q.bind(null)("electron")',
    'Reflect.apply(Q,null,["electron"])',
    'Function.prototype.call.call(Q,null,"electron")',
    'Function.prototype.apply.call(Q,null,["electron"])',
    'Function.prototype.bind.call(Q,null)("electron")',
    'Q.bind(null,"electron").bind(null)()',
  ])("follows the captured host loader through %s", (load) => {
    expect(windows(`${SHIM}new (${load}.BrowserWindow)({});`)).toHaveLength(1);
  });

  it.each([
    ["const saved=Q;require=other;", 'saved.call(null,"electron")'],
    ["const saved=Q.bind(null);require=other;", 'saved("electron")'],
    ["const saved=Q.bind(null);Q.bind=other;", 'saved("electron")'],
    ["const saved=Q.call;Q.call=other;", 'saved.call(Q,null,"electron")'],
    ["const saved=Q.apply;Q.apply=other;", 'saved.call(Q,null,["electron"])'],
    ["const saved=Q.call;", 'saved.call(Q,null,"electron")'],
  ])("retains an earlier callable capture: %s %s", (setup, load) => {
    expect(
      windows(`${SHIM}${setup}new (${load}.BrowserWindow)({});`),
    ).toHaveLength(1);
  });

  it.each([
    ["Q.call=other;", 'Q.call(null,"electron")'],
    ["Q.apply=other;", 'Q.apply(null,["electron"])'],
    ["Q.bind=other;", 'Q.bind(null)("electron")'],
    ["require.call=other;", 'Q.call(null,"electron")'],
    ["require.apply=other;", 'Q.apply(null,["electron"])'],
    ["require.bind=other;", 'Q.bind(null)("electron")'],
    ["const alias=Q;alias.call=other;", 'Q.call(null,"electron")'],
    ["const alias=Q;alias.apply=other;", 'Q.apply(null,["electron"])'],
    ["const alias=Q;alias.bind=other;", 'Q.bind(null)("electron")'],
    [
      'Object.defineProperty(Q,"call",{get(){return other}});',
      'Q.call(null,"electron")',
    ],
    ["Object.setPrototypeOf(Q,{call:other});", 'Q.call(null,"electron")'],
    ["Function.prototype.call=other;", 'Q.call(null,"electron")'],
    ["Function.prototype.apply=other;", 'Q.apply(null,["electron"])'],
    ["Function.prototype.bind=other;", 'Q.bind(null)("electron")'],
    ["Reflect.apply=other;", 'Reflect.apply(Q,null,["electron"])'],
    ["module.require=other;", 'Q.call(null,"electron")'],
    ["const saved=Q.bind(null);module.require=other;", 'saved("electron")'],
    ["Q=other;", 'Q.call(null,"electron")'],
    ['eval("Q=other");', 'Q.apply(null,["electron"])'],
    ["", "Q.apply(null,args)"],
    [
      'Object.defineProperty(Q,"name",{get(){module.require=other;return "x"}});',
      'Q.bind(null)("electron")',
    ],
    [
      'Object.defineProperty(Q,"length",{get(){module.require=other;return 1}});',
      'Q.bind(null)("electron")',
    ],
    [
      "const saved=Q.bind(null);external(saved);",
      'saved.call(null,"electron")',
    ],
  ])("keeps changed or unproven helpers unresolved: %s %s", (setup, load) => {
    expect(windows(`${SHIM}${setup}new (${load}.BrowserWindow)({});`)).toEqual(
      [],
    );
  });

  it.each([
    `const require=other;${SHIM}`,
    "var Q=(e=>false?require:e)(function(){});",
    'const {Q}=(e=>typeof require<"u"?require:e)(function(){});',
    'import require from "foreign";var Q=(e=>typeof require<"u"?require:e)(function(){});',
  ])("does not promote an unproven source: %s", (source) => {
    expect(
      windows(
        `${source}new (Q.call(null,"electron").BrowserWindow)({});`,
        "bundle.mjs",
      ),
    ).toEqual([]);
  });

  it("preserves the existing module-local shim interpretation", () => {
    expect(
      windows(
        `${SHIM}globalThis.Q=other;new (Q.call(null,"electron").BrowserWindow)({});`,
        "bundle.mjs",
      ),
    ).toHaveLength(1);
  });

  it.each([
    'Q.call(null,"node:fs")',
    'Q.apply(null,["node:fs"])',
    'Q.bind(null)("node:fs")',
  ])("retains the existing unsupported module-family policy: %s", (load) => {
    const analysis = analyzeJavaScriptSemantics(
      `${SHIM}const a=require("node:fs");a.readFileSync=other;const b=${load};b.readFileSync("wrong");`,
    );
    expect(analysis.configurationOperations).toEqual([]);
  });
});
