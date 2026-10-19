import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MessageChannel,
  receiveMessageOnPort,
  Worker,
} from "node:worker_threads";

/**
 * Run a CommonJS source through Node's real module loader with only the
 * `electron` package stubbed, and report which BrowserWindow constructor ran.
 *
 * Each source is written as `bundle.cjs` next to a `node_modules/electron`
 * stub and required by a runner inside a fresh worker thread. A worker is a
 * separate V8 isolate with its own globals and its own CommonJS loader, so
 * `require`, `module.require`, `Module.prototype.require`,
 * `module.constructor._load` and the module cache are the genuine ones, a
 * case's prototype mutations never leak into the next case or the test realm,
 * and the realm costs a few tens of milliseconds rather than a process start.
 * The runner defines the free names the corpus uses: `other` returns the
 * replacement module, `unknown` and `external` are inert callables,
 * `unknownReceiver` is the global object and `flag` is true.
 *
 * The record is a primitive string built by concatenation. A case may replace
 * array iteration or any prototype method, so the runner reads nothing back
 * through them.
 */
export type LoaderDelegateOutcome = "original" | "replacement" | "throws";

const RUNNER = `
const { workerData } = require("node:worker_threads");
const { port, signal, bundle } = workerData;
let record = "";
globalThis.__loaderDelegateRecord = function (kind) { record += kind + ";"; };
globalThis.other = function other() {
  return {
    BrowserWindow: function BrowserWindow() {
      globalThis.__loaderDelegateRecord("replacement");
    },
  };
};
globalThis.unknown = function unknown() {};
globalThis.external = function external() { return function () {}; };
globalThis.unknownReceiver = globalThis;
globalThis.flag = true;
let failure = "";
try {
  require(bundle);
} catch (error) {
  failure = "thrown: " + String(error && error.message || error);
}
port.postMessage({ record, failure });
Atomics.store(signal, 0, 1);
Atomics.notify(signal, 0);
`;

const ELECTRON_STUB = `
module.exports = {
  BrowserWindow: function BrowserWindow() {
    globalThis.__loaderDelegateRecord("original");
  },
  ipcMain: { handle() {} },
};
`;

/** Upper bound for one case; a loop in a composed source must not hang the suite. */
const CASE_TIMEOUT_MS = 10_000;

export class LoaderDelegateOracle {
  readonly #root: string;
  readonly #bundle: string;
  readonly #runner: string;

  constructor() {
    this.#root = mkdtempSync(join(tmpdir(), "rea-loader-oracle-"));
    mkdirSync(join(this.#root, "node_modules", "electron"), {
      recursive: true,
    });
    writeFileSync(
      join(this.#root, "node_modules", "electron", "index.js"),
      ELECTRON_STUB,
    );
    this.#bundle = join(this.#root, "bundle.cjs");
    this.#runner = join(this.#root, "run.cjs");
    writeFileSync(this.#runner, RUNNER);
  }

  /** Which constructor the source ran; `throws` when the module threw. */
  loads(source: string): LoaderDelegateOutcome {
    writeFileSync(this.#bundle, source);
    const { port1, port2 } = new MessageChannel();
    const signal = new Int32Array(new SharedArrayBuffer(4));
    const worker = new Worker(this.#runner, {
      workerData: { port: port2, signal, bundle: this.#bundle },
      transferList: [port2],
    });
    try {
      // The runner posts its result, then flips the shared flag. Waiting on
      // the flag keeps the oracle synchronous for plain `it.each` cases.
      const waited = Atomics.wait(signal, 0, 0, CASE_TIMEOUT_MS);
      if (waited === "timed-out")
        throw new Error(`Loader oracle timed out after ${CASE_TIMEOUT_MS}ms`);
      const received = receiveMessageOnPort(port1);
      if (received === undefined)
        throw new Error("Loader oracle finished without a result");
      const { record, failure } = received.message as {
        record: string;
        failure: string;
      };
      if (failure !== "") return "throws";
      const constructors = record.split(";").filter((kind) => kind !== "");
      if (constructors.length !== 1)
        throw new Error(
          `Loader oracle saw ${constructors.length} constructors: ${record}`,
        );
      return constructors[0] === "original" ? "original" : "replacement";
    } finally {
      port1.close();
      void worker.terminate();
    }
  }

  dispose(): void {
    rmSync(this.#root, { recursive: true, force: true });
  }
}
