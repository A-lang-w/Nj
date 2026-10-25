import { runInNewContext } from "node:vm";

import { transformSync } from "esbuild";
import { expect, it } from "vitest";

import { analyzeJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";

it.each([false, true])(
  "retains generated esbuild exports with module use %s",
  (usesModule) => {
    const { code } = transformSync(
      `exports.parse = () => ${usesModule ? "module.id" : "42"};`,
      {
        format: "iife",
        globalName: "fixture",
      },
    );
    const runtime: { fixture?: Record<string, unknown> } = {};
    runInNewContext(code, runtime);
    const expected = Object.keys(runtime.fixture ?? {});
    expect(expected).toEqual(["parse"]);
    const analysis = analyzeJavaScriptStaticSource(code);
    expect(analysis.bundler_registrations).toMatchObject([
      {
        bundler: "esbuild",
        modules: [{ exports: expected, factory_require_name: null }],
      },
    ]);
  },
);

it.each(["module", "renamed"])(
  "uses the %s factory binding for every export receiver",
  (moduleName) => {
    const analysis =
      analyzeJavaScriptStaticSource(`globalThis.webpackChunkApp.push([[1], {
    17(${moduleName}, api, load) {
      ${moduleName}.exports.direct = 1;
      Object.defineProperty(${moduleName}.exports, "defined", {value: 2});
      load.d(${moduleName}.exports, {declared: () => 3});
      { const module = {exports: {}}; module.exports.ghost = 4; }
      { const load = {d() {}}; load.d(api, {fake: () => 5}); }
    }
  }]);`);
    expect(analysis.bundler_registrations[0]?.modules[0]?.exports).toEqual([
      "declared",
      "defined",
      "direct",
    ]);
  },
);

it.each([
  "const Object = {defineProperty() {}};",
  "globalThis.Object.defineProperty = () => {};",
])("requires the global property-definition intrinsic: %s", (prefix) => {
  const analysis =
    analyzeJavaScriptStaticSource(`globalThis.webpackChunkApp.push([[1], {
    17(mod, api) { ${prefix} Object.defineProperty(api, "ghost", {value: 1}); api.real = 2; }
  }]);`);
  expect(analysis.bundler_registrations[0]?.modules[0]?.exports).toEqual([
    "real",
  ]);
});

const webpackChunk = (factory: string): string =>
  `globalThis.webpackChunkApp.push([[1], {17${factory}}]);`;

/** Run the inert fixture factory under Webpack's calling convention. */
const conventionExports = (factory: string): string[] => {
  let table: Record<string, (...values: unknown[]) => void> = {};
  runInNewContext(webpackChunk(factory), {
    globalThis: {
      webpackChunkApp: {
        push: ([, modules]: [unknown, typeof table]) => {
          table = modules;
        },
      },
    },
  });
  const module = { exports: {} };
  const loader = {
    d: (target: object, getters: Record<string, () => unknown>) => {
      for (const [name, get] of Object.entries(getters))
        Object.defineProperty(target, name, { enumerable: true, get });
    },
  };
  table["17"]?.call(module.exports, module, module.exports, loader);
  return Object.getOwnPropertyNames(module.exports).sort();
};

it.each([
  "(e, t) { e.exports = {parse: value => value}; }",
  "(e, t) { e.exports.member = 1; }",
  "(e, t) { e['exports']['computed'] = 1; }",
  "(e, t, n) { Object.defineProperty(e.exports, 'defined', {value: 1}); }",
  "(e, t, n) { n.d(e.exports, {declared: () => 1}); }",
  ": (e, t) => { e.exports = {arrow: 1}; }",
  ": function (e, t) { e.exports = {expression: 1}; }",
  "(e, t) { function inner(e) { e.exports = {ghost: 1}; } e.exports.outer = 1; }",
  "(e, t) { { let e = {}; e.exports = {ghost: 1}; } }",
  "(e, t) { e = {exports: {}}; e.exports.ghost = 1; }",
  "(m, module) { module.exports = {ghost: 1}; }",
  "() {}",
  "(e = {}, t) { e.exports = {defaulted: 1}; }",
  "(e = {exports: {}}, t) { e.exports.defaultedMember = 1; }",
  "(e = {}, t) { e = {exports: {}}; e.exports.ghost = 1; }",
  "(e, t = {}) { t.defaultedExports = 1; }",
  "({exports: x}, t) { x.destructured = 1; }",
  "({exports}, t) { exports.shorthand = 1; }",
  "({exports: x = {}}, t) { x.destructuredDefault = 1; }",
  "({'exports': x}, t) { x.stringKey = 1; }",
  "({id, exports: x}, t) { x.withOther = 1; }",
  "({id}, t) { t.otherKeyOnly = 1; }",
  "({exports: x}, t) { x = {}; x.ghost = 1; }",
  "({exports: x}, t) { function inner(x) { x.ghost = 1; } x.real = 1; }",
  "({exports: x}, t, n) { n.d(x, {declared: () => 1}); Object.defineProperty(x, 'defined', {value: 2}); }",
])("binds factory roles by position for 17%s", (factory) => {
  const analysis = analyzeJavaScriptStaticSource(webpackChunk(factory));
  expect({
    exports: analysis.bundler_registrations[0]?.modules[0]?.exports,
    status: analysis.parse_status,
  }).toEqual({ exports: conventionExports(factory), status: "complete" });
});

it("binds a repeated sloppy parameter name to its last argument", () => {
  const factory =
    ": function (e, t, e) { e.exports = {ghost: 1}; t.second = 1; }";
  const analysis = analyzeJavaScriptStaticSource(webpackChunk(factory));
  // Module source is strict, so the parser recovers from the name clash.
  expect(analysis.analysis_coverage?.syntax.status).toBe("recovered");
  expect(analysis.bundler_registrations[0]?.modules[0]).toMatchObject({
    exports: conventionExports(factory),
    factory_require_name: "e",
  });
});

it.each([
  "(...a) { a[0].exports.rest = 1; }",
  "(e, ...r) { r[0].restExports = 1; }",
  "({...rest}, t) { rest.exports.objectRest = 1; }",
  "({exports: {inner}}, t) { t.nested = 1; }",
  "({[k]: x}, t) { t.computedKey = 1; }",
  "([m], t) { t.arrayPattern = 1; }",
  "(e, {a}) { e.exports.exportsPattern = 1; }",
  "(e, t, n = {}) { n.d(t, {defaultedLoader: () => 1}); }",
  "(e, t, {d}) { d(t, {destructuredLoader: () => 1}); }",
])("reports unresolved factory role pattern 17%s as unknown", (factory) => {
  const analysis = analyzeJavaScriptStaticSource(webpackChunk(factory));
  expect(analysis.bundler_registrations[0]?.modules).toHaveLength(1);
  expect(analysis.parse_status).toBe("partial");
  expect(analysis.analysis_coverage?.semantics.unknown_findings).toBe(1);
});
