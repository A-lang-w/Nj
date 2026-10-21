import { expect, it } from "vitest";
import { createWebPageInspection } from "../../../tests/support/browser/webPageInspection.js";
import { analyzeCapturedWebBundle } from "../webBundleAnalyzer.js";
import { analyzeJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";

const cases = [
  [
    "fresh instance method parameter",
    '(new(class{run([x]){}})()).run((function*(){new Socket("wss://example.test/instance-method");yield 0})());const Socket=globalThis.WebSocket;',
    [],
  ],
  [
    "fresh instance setter parameter",
    '(new(class{set consume([x]){}})()).consume=(function*(){new Socket("wss://example.test/instance-setter");yield 0})();const Socket=globalThis.WebSocket;',
    [],
  ],

  [
    "stored generator after wait",
    '(async()=>{const values=(function*(){new Socket("wss://example.test/stored");yield 0})();await 0;const [x]=values})();const Socket=globalThis.WebSocket;',
    ["wss://example.test/stored"],
  ],
  [
    "stored generator before initialization",
    'const values=(function*(){new Socket("wss://example.test/stored-early");yield 0})();const [x]=values;const Socket=globalThis.WebSocket;',
    [],
  ],

  [
    "later getter",
    'const { unused, run } = { get run() { new Socket("wss://example.test/later-getter"); } }; const Socket = globalThis.WebSocket;',
    [],
  ],
  [
    "later assigned getter",
    'let unused, run; ({ unused, run } = { get run() { new Socket("wss://example.test/assigned-getter"); } }); const Socket = globalThis.WebSocket;',
    [],
  ],
  [
    "initialized later getter",
    'const Socket = globalThis.WebSocket; const { unused, run } = { get run() { new Socket("wss://example.test/initialized-getter"); } };',
    ["wss://example.test/initialized-getter"],
  ],
  [
    "earlier pattern default waits",
    '(async()=>{ const { unused = await 0, run } = { get run() { new Socket("wss://example.test/earlier-default"); } }; })(); const Socket = globalThis.WebSocket;',
    ["wss://example.test/earlier-default"],
  ],
  [
    "earlier pattern key waits",
    '(async()=>{ const { [void await 0]: unused, run } = { get run() { new Socket("wss://example.test/earlier-key"); } }; })(); const Socket = globalThis.WebSocket;',
    ["wss://example.test/earlier-key"],
  ],
  [
    "known earlier default waits",
    '(async()=>{ const { unused = await 0, run } = { unused: undefined, get run() { new Socket("wss://example.test/known-default"); } }; })(); const Socket = globalThis.WebSocket;',
    ["wss://example.test/known-default"],
  ],
  [
    "failed callback argument",
    'const invoke = run => run(); const connect = () => new Socket("wss://example.test/argument"); function earlier() { try { invoke(alias); } catch {} } earlier(); const alias = connect; const Socket = globalThis.WebSocket; invoke(connect);',
    ["wss://example.test/argument"],
  ],
  [
    "failed callback alias chain",
    'const invoke = run => run(); const connect = () => new Socket("wss://example.test/alias-chain"); function earlier() { try { invoke(alias); } catch {} } earlier(); const other = connect; const alias = other; const Socket = globalThis.WebSocket; invoke(connect);',
    ["wss://example.test/alias-chain"],
  ],
  [
    "initialized callback argument still orders entry",
    'const invoke = run => run(); const connect = () => new Socket("wss://example.test/early-argument"); const alias = connect; invoke(alias); const Socket = globalThis.WebSocket;',
    [],
  ],
  [
    "later callback alias works",
    'const invoke = run => run(); const connect = () => new Socket("wss://example.test/later-alias"); function later() { invoke(alias); } const alias = connect; const Socket = globalThis.WebSocket; later();',
    ["wss://example.test/later-alias"],
  ],
  [
    "callback call helper",
    'const invoke = run => run.call(null); const connect = () => new Socket("wss://example.test/callback-call"); const Socket = globalThis.WebSocket; invoke(connect);',
    ["wss://example.test/callback-call"],
  ],
  [
    "callback apply helper",
    'const invoke = run => run.apply(null, []); const connect = () => new Socket("wss://example.test/callback-apply"); const Socket = globalThis.WebSocket; invoke(connect);',
    ["wss://example.test/callback-apply"],
  ],
  [
    "changed string iterator",
    'String.prototype[Symbol.iterator] = function(){ throw 0; }; (async()=>{ try { const [[x], y = await 0] = (function*(){ try { yield "a"; yield undefined; } finally { new Socket("wss://example.test/string-iterator"); } })(); } catch {} })(); const Socket = globalThis.WebSocket;',
    [],
  ],
  [
    "aliased changed string iterator",
    'const prototype = String.prototype; prototype[Symbol.iterator] = function(){ throw 0; }; (async()=>{ try { const [[x], y = await 0] = (function*(){ try { yield "a"; yield undefined; } finally { new Socket("wss://example.test/string-alias"); } })(); } catch {} })(); const Socket = globalThis.WebSocket;',
    [],
  ],
  [
    "native string iterator preserves later wait",
    '(async()=>{ const [[x], y = await 0] = (function*(){ try { yield "a"; yield undefined; } finally { new Socket("wss://example.test/native-string"); } })(); })(); const Socket = globalThis.WebSocket;',
    ["wss://example.test/native-string"],
  ],
  [
    "unrelated string property preserves iteration",
    'String.prototype.unrelated = 0; (async()=>{ const [[x], y = await 0] = (function*(){ try { yield "a"; yield undefined; } finally { new Socket("wss://example.test/unrelated-string"); } })(); })(); const Socket = globalThis.WebSocket;',
    ["wss://example.test/unrelated-string"],
  ],
  [
    "later iterator write follows acquisition",
    '(async()=>{ const [[x], y = await 0] = (function*(){ try { yield "a"; yield undefined; } finally { new Socket("wss://example.test/later-string"); } })(); })(); String.prototype[Symbol.iterator] = function(){ throw 0; }; const Socket = globalThis.WebSocket;',
    ["wss://example.test/later-string"],
  ],
  [
    "initialized cleanup after changed iterator",
    'const Socket = globalThis.WebSocket; String.prototype[Symbol.iterator] = function(){ throw 0; }; (async()=>{ try { const [[x], y = await 0] = (function*(){ try { yield "a"; yield undefined; } finally { new Socket("wss://example.test/initialized-string"); } })(); } catch {} })();',
    ["wss://example.test/initialized-string"],
  ],
] as const;

for (const consumer of ["source", "captured"] as const) {
  it.each(cases)(
    `${consumer} preserves activation order: %s`,
    (_name, source, expected) => {
      if (consumer === "source") {
        const standalone = analyzeJavaScriptStaticSource(source);
        expect(standalone.parse_status).not.toBe("failed");
        expect(standalone.endpoints.map(({ value }) => value)).toEqual(
          expected,
        );
      } else {
        const captured = analyzeCapturedWebBundle(
          createWebPageInspection([
            {
              source,
              scriptKey: `scr_${"1".repeat(64)}`,
              url: "https://app.example.test/main.js",
              origin: "https://app.example.test",
              cdpHash: "hash",
            },
          ]),
        );
        expect(
          captured.observations.endpoints.map(({ value }) => value),
        ).toEqual(expected);
      }
    },
  );
}

it("retains all independently stored generator consumers", () => {
  const count = 80;
  const entries = Array.from(
    { length: count },
    (_, index) =>
      `const values${index}=(function*(){new Socket("wss://example.test/stored-${index}");yield 0})();const [item${index}]=values${index};`,
  ).join("");
  const source = `const Socket=globalThis.WebSocket;${entries}`;
  const endpoints = analyzeJavaScriptStaticSource(source).endpoints.map(
    ({ value }) => value,
  );
  expect(endpoints).toHaveLength(count);
  expect(new Set(endpoints)).toEqual(
    new Set(
      Array.from(
        { length: count },
        (_, index) => `wss://example.test/stored-${index}`,
      ),
    ),
  );
});
