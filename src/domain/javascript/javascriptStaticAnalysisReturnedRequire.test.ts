import { expect, it } from "vitest";

import { analyzeJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";

it.each([
  ["Array.prototype[0]=module;", true],
  ["Array.prototype['0']=module;", true],
  ["Array.prototype.constructor.prototype[0]=module;", true],
  ["Array.prototype['01']=module;", false],
  ["Array.prototype.extra=module;", false],
  ["Array.prototype.require=replacement;", false],
])("retains inherited numeric array iteration slots: %s", (write, expected) => {
  const analysis = analyzeJavaScriptStaticSource(
    `${write}const [api]=[,];api.require('./shared.cjs');`,
  );
  expect(analysis.parse_error_count).toBe(0);
  expect(analysis.references).toEqual(
    expected
      ? [expect.objectContaining({ kind: "require", specifier: null })]
      : [],
  );
});

it.each([
  [
    "Array.prototype.constructor.prototype[Symbol.iterator]=function*(){yield module;};",
    true,
  ],
  [
    "Array.prototype.constructor.prototype.constructor.prototype[Symbol.iterator]=custom;",
    true,
  ],
  ["Array.prototype.constructor.prototype.extra=1;", false],
  ["Array.prototype.constructor.prototype.require=replacement;", false],
  ["Array.prototype.require=replacement;", false],
])(
  "tracks iterator changes through prototype constructor cycles: %s",
  (write, expected) => {
    const analysis = analyzeJavaScriptStaticSource(
      `${write}const [selected]=[];selected.require('./shared.cjs');`,
    );
    expect(analysis.parse_error_count).toBe(0);
    expect(analysis.references).toEqual(
      expected
        ? [expect.objectContaining({ kind: "require", specifier: null })]
        : [],
    );
  },
);

it.each([
  ["const get=()=>module;get()", true],
  ["function get(){return module;}get()", true],
  ["const get=()=>module;const alias=get;alias()", true],
  ["const get=()=>({loader:module});get().loader", true],
  ["const get=()=>flag?module:{};get()", true],
  ["const inner=()=>module;const get=()=>inner();get()", true],
  ["(()=>module)()", true],
  ["const get=()=>({require(){}});get()", false],
  ["const get=()=>module.exports;get()", false],
  ["function get(module){return module;}get({require(){}})", false],
  ["let get=()=>module;get=()=>({require(){}});get()", false],
])("retains possible returned module receivers: %s", (receiver, expected) => {
  const analysis = analyzeJavaScriptStaticSource(
    `${receiver}.require('./shared.cjs');`,
  );
  expect(analysis.parse_error_count).toBe(0);
  expect(analysis.references).toEqual(
    expected
      ? [expect.objectContaining({ kind: "require", specifier: null })]
      : [],
  );
});

it.each([
  [
    "const [api]=[module];Array.prototype.extra=1;api.require=replacement;",
    true,
  ],
  [
    "const [api]=[module];Array.prototype[Symbol.iterator]=custom;api.require=replacement;",
    true,
  ],
  ["const [api]=[{}];Array.prototype.extra=1;api.require=replacement;", false],
  [
    "const values={*[Symbol.iterator](){yield module;}};const [api]=values;api.require=replacement;",
    true,
  ],
  [
    "const values=[{}];values[Symbol.iterator]=function*(){yield module;};const [api]=values;api.require=replacement;",
    true,
  ],
  [
    "Array.prototype[Symbol.iterator]=custom;const [api]=[{}];api.require=replacement;",
    true,
  ],
  ["const get=()=>module;get().require=replacement;", true],
  ["const get=()=>({require(){}});get().require=replacement;", false],
])(
  "retains host delegate uncertainty after possible receiver writes: %s",
  (write, expected) => {
    const analysis = analyzeJavaScriptStaticSource(
      `${write}require('./shared.cjs');`,
    );
    expect(analysis.references).toEqual([
      expect.objectContaining({
        kind: "require",
        specifier: expected ? null : "./shared.cjs",
      }),
    ]);
  },
);

it("preserves a require before later returned-receiver delegate writes", () => {
  const analysis = analyzeJavaScriptStaticSource(
    `require('./shared.cjs');const get=()=>module;get().require=replacement;`,
  );
  expect(analysis.references).toEqual([
    expect.objectContaining({ kind: "require", specifier: "./shared.cjs" }),
  ]);
});
