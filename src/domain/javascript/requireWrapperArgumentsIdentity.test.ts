import { describe, expect, it } from "vitest";

import { analyzeParsedJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";
import { parseJavaScriptSource } from "./javascriptSourceParser.js";

const windows = (source: string) => {
  const parsed = parseJavaScriptSource(source, "entry.cjs");
  expect(parsed).not.toBeNull();
  return analyzeParsedJavaScriptStaticSource(source, parsed!).electron
    .browser_windows;
};
const loadWindow = 'new(load("electron").BrowserWindow)({});';
const callWindow = 'new(load.call(null,"electron").BrowserWindow)({});';

describe.each(["", '"use strict";'])(
  "wrapper argument values: %s",
  (directive) => {
    it.each([
      "const load=require;",
      "const load=require.bind(null);",
      'var load=(e=>typeof require<"u"?require:e)(function(){});',
    ])("retains the module object after loader capture: %s", (capture) => {
      expect(
        windows(
          `${directive}${capture}arguments[2].require=other;${loadWindow}`,
        ),
      ).toEqual([]);
    });

    it.each([
      "arguments[1].call=other;",
      "const args=arguments;args[1].call=other;",
      'Object.defineProperty(arguments[1],"call",{value:other});',
      "arguments[1].call.call=other;",
    ])("retains callable helper identity: %s", (write) => {
      const call = write.includes("call.call")
        ? 'new(load.call.call(load,null,"electron").BrowserWindow)({});'
        : callWindow;
      expect(windows(`${directive}const load=require;${write}${call}`)).toEqual(
        [],
      );
    });

    it("preserves a load before a later argument-object mutation", () => {
      expect(
        windows(
          `${directive}const load=require;${loadWindow}arguments[2].require=other;${loadWindow}`,
        ),
      ).toHaveLength(1);
    });

    it.each([
      ["arguments[2]={};arguments[2].require=other;", loadWindow],
      ["arguments[1]={};arguments[1].call=other;", callWindow],
      ["arguments[0]={};arguments[0].require=other;", loadWindow],
      [
        'Object.defineProperty(arguments,"2",{value:{}});arguments[2].require=other;',
        loadWindow,
      ],
      [
        'Object.defineProperty(arguments,"1",{value:{}});arguments[1].call=other;',
        callWindow,
      ],
      ["const args=arguments;args[2]={};args[2].require=other;", loadWindow],
      [
        "arguments[2]={};const target=arguments[2];target.require=other;",
        loadWindow,
      ],
    ])("selects a definite argument-slot replacement: %s", (setup, use) => {
      expect(
        windows(`${directive}const load=require;${setup}${use}`),
      ).toHaveLength(1);
    });

    it.each([
      "const target=arguments[2];arguments[2]={};target.require=other;",
      "exports.target=module;arguments[0].target.require=other;",
      "arguments[3]=module;arguments[3].require=other;",
      "const args=arguments;args.target=module;args.target.require=other;",
      'Object.defineProperty(arguments,"2",{get(){return module}});arguments[2]={};arguments[2].require=other;',
      'Object.defineProperty(arguments,"2",{set(value){module.require=other}});arguments[2]={};',
    ])("retains captures and unproven descriptor replacements: %s", (setup) => {
      expect(
        windows(`${directive}const load=require;${setup}${loadWindow}`),
      ).toEqual([]);
    });

    it("keeps an ordinary function's own arguments separate", () => {
      expect(
        windows(
          `${directive}const load=require;function patch(){arguments[2].require=other}patch(null,null,{});${loadWindow}`,
        ),
      ).toHaveLength(1);
    });

    it.each([0, 3, 4])(
      "retains shared helpers from initial argument %s",
      (index) => {
        expect(
          windows(
            `${directive}const load=require;arguments[${index}].toString.call.call=other;new(load.call.call(load,null,"electron").BrowserWindow)({});`,
          ),
        ).toEqual([]);
      },
    );

    it.each([
      "arguments.callee",
      "arguments.toString",
      "arguments.__proto__.toString",
      "arguments.length.toString",
    ])(
      "retains shared helpers from unmodeled arguments members: %s",
      (member) => {
        expect(
          windows(
            `${directive}const load=require;${member}.call.call=other;new(load.call.call(load,null,"electron").BrowserWindow)({});`,
          ),
        ).toEqual([]);
      },
    );

    it("preserves primitive length reads and definite unmodeled-member replacements", () => {
      expect(
        windows(
          `${directive}const load=require;void arguments.length;arguments.extra={};arguments.extra.require=other;${loadWindow}`,
        ),
      ).toHaveLength(1);
    });
  },
);

it.each([
  "const args=arguments;arguments={};args[2].require=other;",
  "var arguments;const args=arguments;arguments={};args[2].require=other;",
  "const args=arguments;var arguments={};args[2].require=other;",
])(
  "retains a wrapper object captured before binding replacement: %s",
  (setup) => {
    expect(windows(`const load=require;${setup}${loadWindow}`)).toEqual([]);
  },
);

it.each([
  "var arguments={};arguments[2]={};arguments[2].require=other;",
  "let arguments={};arguments[2]={};arguments[2].require=other;",
  "const arguments={2:{}};arguments[2].require=other;",
  "arguments={2:{}};const args=arguments;args[2].require=other;",
])(
  "preserves host identity after arguments binding replacement: %s",
  (setup) => {
    expect(windows(`const load=require;${setup}${loadWindow}`)).toHaveLength(1);
  },
);

it.each([
  "arguments[1].call=other;new(require.call(null,'electron').BrowserWindow)({});",
  "arguments[2].require=other;new(require('electron').BrowserWindow)({});",
])("retains unmapped argument values in strict wrappers: %s", (source) => {
  expect(windows(`"use strict";${source}`)).toEqual([]);
});

it.each([
  ["require=module;arguments[1].require=other;", loadWindow],
  ["module=require;arguments[2].call=other;", callWindow],
  ["exports=module;arguments[0].require=other;", loadWindow],
  ["__filename=module;arguments[3].require=other;", loadWindow],
  ["__dirname=require;arguments[4].call=other;", callWindow],
])("retains mapped parameter replacements: %s", (setup, use) => {
  expect(windows(`const load=require;${setup}${use}`)).toEqual([]);
});

it.each([
  ["require=module;arguments[1].require=other;", loadWindow],
  ["module=require;arguments[2].call=other;", callWindow],
])(
  "keeps strict parameter writes separate from argument values: %s",
  (setup, use) => {
    expect(
      windows(`"use strict";const load=require;${setup}${use}`),
    ).toHaveLength(1);
  },
);
