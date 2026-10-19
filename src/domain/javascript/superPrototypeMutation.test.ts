import { runInNewContext } from "node:vm";

import { expect, it } from "vitest";

import { analyzeJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";

const SHIM = 'var Q=(e=>typeof require<"u"?require:e)(function(){});';
const USE =
  "target.fetch=other;target.Q=other;fetch('/kept');new(Q('electron').BrowserWindow)({});";

const changedHomes = [
  [
    "object setter call",
    "const a={get value(){return {}}};const b={get value(){return globalThis}};const c={__proto__:a,get result(){return super.value}};Object.setPrototypeOf(c,b);const target=c.result;",
  ],
  [
    "object legacy setter",
    "const a={get value(){return {}}};const b={get value(){return globalThis}};const c={__proto__:a,get result(){return super.value}};c.__proto__=b;const target=c.result;",
  ],
  [
    "object Reflect setter",
    "const a={get value(){return {}}};const b={get value(){return globalThis}};const c={__proto__:a,get result(){return super.value}};Reflect.setPrototypeOf(c,b);const target=c.result;",
  ],
  [
    "object without a literal prototype",
    "const b={get value(){return globalThis}};const c={get result(){return super.value}};Object.setPrototypeOf(c,b);const target=c.result;",
  ],
  [
    "class instance",
    "class A{get value(){return {}}}class B extends A{get result(){return super.value}}const p={get value(){return globalThis}};Object.setPrototypeOf(B.prototype,p);const target=new B().result;",
  ],
  [
    "class static",
    "class A{static get value(){return {}}}class B extends A{static get result(){return super.value}}class P{static get value(){return globalThis}}Object.setPrototypeOf(B,P);const target=B.result;",
  ],
  [
    "class instance data slot",
    "class A{}class B extends A{get result(){return super.value}}Object.setPrototypeOf(B.prototype,{value:globalThis});const target=new B().result;",
  ],
  [
    "class static data slot",
    "class A{}class B extends A{static get result(){return super.value}}Object.setPrototypeOf(B,{value:globalThis});const target=B.result;",
  ],
] as const;

const verify = (setup: string, expected: number): void => {
  const calls: string[] = [];
  const original = function () {
    calls.push("original");
  };
  const replacement = function () {
    calls.push("replacement");
  };
  const source = SHIM + setup + USE;
  runInNewContext(
    source,
    {
      require: () => ({ BrowserWindow: original }),
      fetch: original,
      other: () => {
        replacement();
        return { BrowserWindow: replacement };
      },
    },
    { timeout: 1000 },
  );
  expect(calls).toEqual(
    expected === 1
      ? ["original", "original"]
      : ["replacement", "replacement", "replacement"],
  );
  const result = analyzeJavaScriptStaticSource(source);
  expect(
    result.endpoints.filter(({ mechanism }) => mechanism === "call:fetch"),
  ).toHaveLength(expected);
  expect(result.electron.browser_windows).toHaveLength(expected);
};

it.each(changedHomes)(
  "follows the current super home prototype for %s",
  (_name, setup) => verify(setup, 0),
);

it.each([
  "const box={};function get(){return box}const obj=get();box.value=globalThis;const target=obj.value;",
  "const box={};function get(){return box}const obj=get();const holder={};holder.p={value:globalThis};Object.setPrototypeOf(box,holder.p);const target=obj.value;",
  "const box={};function get(){return box}const obj=get();const holder={};holder.p={value:globalThis};box.__proto__=holder.p;const target=obj.value;",
  "const box={};function get(){return box}const obj=get();Object.prototype.bridge={value:globalThis};Object.setPrototypeOf(box,({}).bridge);const target=obj.value;",

  "const box={};const obj={get result(){return box}}.result;Object.setPrototypeOf(box,{value:globalThis});const target=obj.value;",
  "const box={};const a={value:box};const c={__proto__:a,get result(){return super.value}};const obj=c.result;box.value=globalThis;const target=obj.value;",
  "const holder={};const box={get value(){return holder.x}};function get(){return box}const obj=get();holder.x=globalThis;const target=obj.value;",
  "const holder={};const box={get value(){return holder.x}};const obj={get result(){return box}}.result;holder.x=globalThis;const target=obj.value;",
  "const holder={};class C{static get value(){return holder.x}}function get(){return C}const obj=get();holder.x=globalThis;const target=obj.value;",
  "const a={value:{}};const b={value:globalThis};const c={__proto__:a,get result(){Object.setPrototypeOf(c,b);return super.value}};const target=c.result;",
  "const a={value:{}};const b={value:globalThis};const c={__proto__:a,get result(){return ()=>super.value}};const get=c.result;Object.setPrototypeOf(c,b);const target=get();",
])("retains writes before a later consumer reads %s", (setup) =>
  verify(setup, 0),
);

it.each([
  "class A{get value(){return {}}}class B extends A{set __proto__(v){}get result(){return super.value}}B.prototype.__proto__={value:globalThis};const target=new B().result;",
  "class A{get value(){return {}}}class B extends A{get result(){return super.value}}Object.defineProperty(B.prototype,'__proto__',{value:null,writable:true});B.prototype.__proto__={value:globalThis};const target=new B().result;",
  "class A{get value(){return {}}set __proto__(v){}}class B extends A{get result(){return super.value}}B.prototype.__proto__={value:globalThis};const target=new B().result;",
  "class A{}class B extends A{}Object.setPrototypeOf(B.prototype,{value:globalThis});const target=({...B.prototype}).value??{};",
  "class A{}class B extends A{}Object.setPrototypeOf(B.prototype,{value:globalThis});const holder={p:B.prototype};const target=({...holder.p}).value??{};",
  "Object.prototype.value={};const c={get result(){return super.value}};const target=c.result;Object.prototype.value=globalThis;",
  "Object.prototype.value={};class B{get result(){return super.value}}const target=new B().result;Object.prototype.value=globalThis;",
  "Function.prototype.value={};class B{static get result(){return super.value}}const target=B.result;Function.prototype.value=globalThis;",
  "const a={value:{}};const b={value:globalThis};const c={__proto__:a,get result(){return super.value}};function get(){return c.result}const target=get();Object.setPrototypeOf(c,b);",
  "const a={value:{}};const b={value:globalThis};const c={__proto__:a,get result(){return super.value}};const d={get value(){return c.result}};const target=d.value;Object.setPrototypeOf(c,b);",
  "const a={get value(){return {}}};const b={get value(){return {}}};const c={__proto__:a,get result(){return super.value}};Object.setPrototypeOf(c,b);const target=c.result;",
  "class A{get value(){return {}}}class B extends A{get result(){return super.value}}const p={get value(){return {}}};Object.setPrototypeOf(B.prototype,p);const target=new B().result;",
  "const a={value:{}};const b={value:globalThis};const c={__proto__:a,get result(){return super.value}};const target=c.result;Object.setPrototypeOf(c,b);",
])("preserves local selections and earlier captures for %s", (setup) =>
  verify(setup, 1),
);
