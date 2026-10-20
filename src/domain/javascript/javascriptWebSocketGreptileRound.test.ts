import { expect, it } from "vitest";

import { analyzeJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";

const endpoints = (source: string): string[] => {
  const analysis = analyzeJavaScriptStaticSource(source);
  expect(analysis.parse_status).not.toBe("failed");
  return analysis.endpoints.map(({ value }) => value);
};

it.each([
  [
    "keeps callback suppliers paired with their invocation",
    `
      const invoke = run => run();
      invoke(() => {});
      const Socket = globalThis.WebSocket;
      invoke(() => new Socket("wss://example.test/pair"));
    `,
    "wss://example.test/pair",
  ],
  [
    "does not enter apply receivers when argument-list creation fails",
    `
      const connect = () => new Socket("wss://example.test/apply");
      try { connect.apply(null, 1); } catch {}
      const Socket = globalThis.WebSocket;
    `,
    "wss://example.test/apply",
  ],
  [
    "accepts an inert method as import attributes",
    `
      export {};
      const { WebSocket: Socket } = await import("ws", { with() {} });
      new Socket("wss://example.test/options");
    `,
    "wss://example.test/options",
  ],
  [
    "falls back from a setter-only async disposer to a sync disposer",
    `
      (async () => {
        for (const value of (function* () {
          yield 0;
          new Socket("wss://example.test/disposer");
        })()) {
          await using resource = {
            set [Symbol.asyncDispose](value) {},
            [Symbol.dispose]() {},
          };
        }
      })();
      const Socket = globalThis.WebSocket;
    `,
    "wss://example.test/disposer",
  ],
] as const)("%s", (_name, source, endpoint) => {
  expect(endpoints(source)).toEqual([endpoint]);
});

it("orders helper selection before argument writes", () => {
  expect(
    endpoints(`
      const connect = () => new Socket("wss://example.test/helper-read");
      connect.call(null, connect.call = () => {});
      const Socket = globalThis.WebSocket;
    `),
  ).toEqual([]);
});

it.each([
  [
    "enters base fields when an implicit subclass is constructed",
    `
      class Base { field = new Socket("wss://example.test/base-field"); }
      class Derived extends Base {}
      new Derived();
      const Socket = globalThis.WebSocket;
    `,
  ],
  [
    "enters a native Promise executor synchronously",
    `
      new Promise(() => new Socket("wss://example.test/promise-executor"));
      const Socket = globalThis.WebSocket;
    `,
  ],
  [
    "enters a fresh getter selected by object destructuring",
    `
      const { run } = {
        get run() { return new Socket("wss://example.test/destructured-getter"); }
      };
      const Socket = globalThis.WebSocket;
    `,
  ],
] as const)("%s", (_name, source) => {
  expect(endpoints(source)).toEqual([]);
});
