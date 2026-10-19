import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vitest";

import { analyzeJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";

describe("destructuring defined source slots", () => {
  it.each([
    [
      "own static method",
      "const {helper:target=globalThis}=class{static helper(){}};",
    ],
    [
      "literal computed static method",
      'const {helper:target=globalThis}=class{static ["helper"](){}};',
    ],
    [
      "inherited static method from a literal prototype",
      "const {helper:target=globalThis}={__proto__:class{static helper(){}}};",
    ],
    [
      "nested static method",
      "const {value:{helper:target=globalThis}}={value:class{static helper(){}}};",
    ],
    ["string length", 'const {length:target=globalThis}="x";'],
    ["empty string length", 'const {length:target=globalThis}="";'],
    ["string index", 'const {0:target=globalThis}="x";'],
    [
      "nested string length",
      'const {value:{length:target=globalThis}}={value:"x"};',
    ],
  ])("excludes the fallback for %s", (_name, setup) => {
    expect(
      runInNewContext(
        `const original=fetch;${setup}target.fetch=other;fetch===original;`,
        { fetch() {}, other() {} },
      ),
    ).toBe(true);
    expect(
      analyzeJavaScriptStaticSource(
        `${setup}target.fetch=other;fetch('/local');`,
      ).endpoints.filter(({ mechanism }) => mechanism === "call:fetch"),
    ).toMatchObject([{ value: "/local" }]);
  });

  it.each([
    [
      "unknown computed static method",
      'const key="other";const {helper:target=globalThis}=class{static [key](){}};',
    ],
    [
      "static accessor",
      "const {helper:target=globalThis}=class{static get helper(){return undefined}};",
    ],
    [
      "static accessor replacing a method",
      "const {helper:target=globalThis}=class{static helper(){}static get helper(){return undefined}};",
    ],
    ["instance method", "const {helper:target=globalThis}=class{helper(){}};"],
    [
      "static field replacing a method",
      "const {helper:target=globalThis}=class{static helper(){}static helper=undefined};",
    ],
    [
      "static block removing a method",
      "const {helper:target=globalThis}=class{static helper(){}static{delete this.helper}};",
    ],
    [
      "named class mutation",
      "const source=class{static helper(){}};source.helper=undefined;const {helper:target=globalThis}=source;",
    ],
    [
      "earlier default mutating the class",
      "const {prototype:{constructor:saved},unused=(saved.helper=undefined),helper:target=globalThis}=class{static helper(){}};",
    ],
    ["missing string index", 'const {1:target=globalThis}="x";'],
    ["noncanonical string index", 'const {"00":target=globalThis}="x";'],
    [
      "ignored string prototype length",
      'const {length:target=globalThis}={__proto__:"x"};',
    ],
    [
      "ignored string prototype index",
      'const {0:target=globalThis}={__proto__:"x"};',
    ],
  ])("retains the fallback for %s", (_name, setup) => {
    expect(
      runInNewContext(
        `const original=fetch;${setup}target.fetch=other;fetch===original;`,
        { fetch() {}, other() {} },
      ),
    ).toBe(false);
    expect(
      analyzeJavaScriptStaticSource(
        `${setup}target.fetch=other;fetch('/local');`,
      ).endpoints.filter(({ mechanism }) => mechanism === "call:fetch"),
    ).toEqual([]);
  });
});
