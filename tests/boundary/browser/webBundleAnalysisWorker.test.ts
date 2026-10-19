import { access, mkdir, rm } from "node:fs/promises";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { CdpBrowserProvider } from "../../../src/browser/CdpBrowserProvider.js";
import { analyzeWebBundle } from "../../../src/application/BrowserObservationService.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { ProviderCleanupError } from "../../../src/domain/providerCleanupError.js";
import { analyzeWebBundleScript } from "../../../src/domain/webBundleAnalyzerInspection.js";
import {
  AnalysisCancelledError,
  AnalysisOutputError,
} from "../../../src/domain/analysisErrorCore.js";
import { resolvedAnalysisError } from "../../../src/domain/analysisErrorBase.js";
import { OwnedFileHandle } from "../../../src/filesystem/OwnedFileHandle.js";
import { err, ok } from "../../../src/domain/result.js";
import { analyzeWebBundleInputSchema } from "../../../src/domain/webBundleAnalysis.js";
import { startFakeCdpBrowser } from "../../fixtures/fakeCdpBrowser.js";
import { trackBrowser } from "./cdpBrowserProvider.support.js";
import { ProviderAdapterError } from "../../../src/domain/providerAdapterError.js";
import type { IncludedScript } from "../../../src/domain/webBundleAnalyzerInspection.js";
import { createWebTextArtifact } from "../../../src/domain/webContentArtifact.js";
import type { WebBundleAnalysisWorkerDependencies } from "../../../src/browser/WebBundleAnalysisWorker.js";
import {
  WebBundleAnalysisOwner,
  type WebBundleScriptAnalyzer,
} from "../../../src/browser/WebBundleAnalysisOwner.js";
import { javaScriptRuntime } from "../../../src/domain/runtimeVersion.js";
import { PrivateRuntimeRoot } from "../../../src/process/PrivateRuntimeRoot.js";
import { spawnOwnedProviderProcess } from "../../../src/process/ProviderProcess.js";
import { cleanupOwnedProcessGroup } from "../../../src/process/ProcessOwnership.js";
import { waitForAbortableDelay } from "../../../src/process/ProviderDeadline.js";

/** One-shot test calls still close their provider lifetime. */
const analyzeWebBundleScripts = async (
  scripts: readonly IncludedScript[],
  options: Parameters<WebBundleScriptAnalyzer["analyze"]>[1],
  dependencies: WebBundleAnalysisWorkerDependencies = {},
) => {
  const owner = new WebBundleAnalysisOwner(dependencies);
  try {
    return await owner.analyze(scripts, options);
  } finally {
    await owner.close();
  }
};

const recordingAnalyzer = (
  analyze: WebBundleScriptAnalyzer["analyze"],
): WebBundleScriptAnalyzer => ({ analyze, close: async () => undefined });

const deferred = () => {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
};

const origin = "https://app.example.test";

const script = (index: number, source: string): IncludedScript => ({
  script_key: `scr_${String(index).repeat(64)}`,
  frame_id: null,
  url: `${origin}/assets/${String(index)}.js`,
  origin,
  cdp_hash: null,
  length: Buffer.byteLength(source),
  is_module: false,
  language: "JavaScript",
  source_map_url: null,
  resource_reconciliation: {
    status: "unmatched",
    reason: "no_exact_sanitized_url",
  },
  source: {
    included: true,
    artifact: createWebTextArtifact(source, "text/javascript"),
  },
});

/** Seconds of static analysis and hundreds of MiB of heap on the real analyzer. */
const expensive = (index: number): IncludedScript => {
  let source = "";
  for (let item = 0; item < 20_000; item += 1)
    source += `function f${String(item)}(a){ var o = {x: a}; o.y = f${String(Math.max(0, item - 1))}; fetch('/heavy/${String(item)}'); return o; }\n`;
  return script(index, source);
};
const small = (index: number): IncludedScript =>
  script(index, `fetch("/api/kept-${String(index)}");`);

/** Record each private root so the test can prove it was released. */
const tracked = (
  overrides: WebBundleAnalysisWorkerDependencies = {},
): WebBundleAnalysisWorkerDependencies & { readonly roots: string[] } => {
  const roots: string[] = [];
  return {
    ...overrides,
    roots,
    createRuntime: async () => {
      const root = await PrivateRuntimeRoot.create({ prefix: "rea-wb-test-" });
      roots.push(root.path);
      return root;
    },
  };
};

const released = async (paths: readonly string[]): Promise<void> => {
  for (const path of paths)
    await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
};

const endpoints = (outcome: unknown): string[] =>
  (
    outcome as { facts: { endpoints: { value: string }[] } }
  ).facts.endpoints.map(({ value }) => value);

it("stages only the admitted script and releases it before the next admission", async () => {
  const staged: string[][] = [];
  const dependencies = tracked({
    launcher: async (options) => {
      const spawned = await spawnOwnedProviderProcess(options);
      const root = options.cwd;
      if (root === undefined) throw new Error("Missing worker root");
      let pending = "";
      spawned.process.stdout?.on("data", (chunk: Buffer) => {
        pending += chunk.toString("utf8");
        let newline: number;
        while ((newline = pending.indexOf("\n")) >= 0) {
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          if (line.includes('"start"'))
            staged.push(
              readdirSync(root).filter((name) => name.endsWith(".script.json")),
            );
        }
      });
      return spawned;
    },
  });
  const result = await analyzeWebBundleScripts(
    [small(0), small(1), small(2)],
    {},
    dependencies,
  );
  if (!result.ok) throw result.error.error;
  expect(staged).toEqual([
    ["0.script.json"],
    ["1.script.json"],
    ["2.script.json"],
  ]);
  expect(result.value).toHaveLength(3);
  await released(dependencies.roots);
}, 60_000);

it.each(["read", "decode"])(
  "keeps facts %s under the script deadline",
  async (phase) => {
    const budget = 750;
    let arm = false;
    let stalled = false;
    const originalClose = OwnedFileHandle.prototype.close;
    const close = vi
      .spyOn(OwnedFileHandle.prototype, "close")
      .mockImplementation(async function (this: OwnedFileHandle) {
        if (arm && !stalled && phase === "read") {
          stalled = true;
          await waitForAbortableDelay(budget + 250);
        }
        await originalClose.call(this);
      });
    const originalDecode = TextDecoder.prototype.decode;
    const decode = vi
      .spyOn(TextDecoder.prototype, "decode")
      .mockImplementation(function (this: TextDecoder, ...args) {
        if (arm && !stalled && phase === "decode") {
          stalled = true;
          Atomics.wait(
            new Int32Array(new SharedArrayBuffer(4)),
            0,
            0,
            budget + 250,
          );
        }
        return originalDecode.apply(this, args);
      });
    const dependencies = tracked({
      limits: { scriptTimeoutMs: budget },
      launcher: async (options) => {
        const spawned = await spawnOwnedProviderProcess(options);
        spawned.process.stdout?.on("data", (chunk: Buffer) => {
          if (chunk.toString("utf8").includes('"kind":"done","index":0'))
            arm = true;
        });
        return spawned;
      },
    });
    try {
      const result = await analyzeWebBundleScripts(
        [small(0), small(1)],
        {},
        dependencies,
      );
      if (!result.ok) throw result.error.error;
      expect(stalled).toBe(true);
      expect(result.value[0]).toMatchObject({
        status: "resource_limited",
        resource: "cpu",
      });
      expect(endpoints(result.value[1])).toEqual(["/api/kept-1"]);
      await released(dependencies.roots);
    } finally {
      close.mockRestore();
      decode.mockRestore();
    }
  },
  60_000,
);

describe("owned web bundle analysis worker bounds", () => {
  it.runIf(javaScriptRuntime(process.versions).id === "node")(
    "reports V8 heap exhaustion for one script and keeps the others",
    async () => {
      const dependencies = tracked({ limits: { heapMb: 96 } });
      const result = await analyzeWebBundleScripts(
        [small(1), expensive(2), small(3)],
        {},
        dependencies,
      );
      if (!result.ok) throw result.error.error;
      expect(result.value.map(({ status }) => status)).toEqual([
        "analyzed",
        "resource_limited",
        "analyzed",
      ]);
      expect(result.value[1]).toMatchObject({
        script_key: expensive(2).script_key,
        resource: "memory",
      });
      expect(endpoints(result.value[0])).toEqual(["/api/kept-1"]);
      expect(endpoints(result.value[2])).toEqual(["/api/kept-3"]);
      await released(dependencies.roots);
    },
    60_000,
  );

  it("stops a script at its deadline and resumes with the next script", async () => {
    const dependencies = tracked({ limits: { scriptTimeoutMs: 500 } });
    const result = await analyzeWebBundleScripts(
      [expensive(1), small(2)],
      {},
      dependencies,
    );
    if (!result.ok) throw result.error.error;
    expect(result.value[0]).toMatchObject({
      status: "resource_limited",
      resource: "cpu",
    });
    expect(endpoints(result.value[1])).toEqual(["/api/kept-2"]);
    await released(dependencies.roots);
  }, 60_000);

  it.each(["start", "done"])(
    "does not renew an expired deadline when a queued %s frame is consumed",
    async (phase) => {
      const scriptTimeoutMs = 750;
      const pids: number[] = [];
      const unadmittedResults: string[] = [];
      let delayedStop = false;
      let stalled = false;
      const dependencies = tracked({
        limits: { scriptTimeoutMs },
        launcher: async (options) => {
          const root = options.cwd;
          if (root === undefined) throw new Error("Missing worker root");
          const spawned = await spawnOwnedProviderProcess(options);
          if (spawned.process.pid !== undefined) pids.push(spawned.process.pid);
          let pending = "";
          // Registered before the parent's protocol listener. The real worker
          // can finish while its parent cannot consume the start/done frame.
          spawned.process.stdout?.on("data", (chunk: Buffer) => {
            pending += chunk.toString("utf8");
            let newline: number;
            while ((newline = pending.indexOf("\n")) >= 0) {
              const line = pending.slice(0, newline);
              pending = pending.slice(newline + 1);
              if (!stalled && line.includes(`"kind":"${phase}","index":1`)) {
                stalled = true;
                Atomics.wait(
                  new Int32Array(new SharedArrayBuffer(4)),
                  0,
                  0,
                  scriptTimeoutMs + 250,
                );
              }
            }
          });
          return {
            ...spawned,
            cleanup: async () => {
              if (!delayedStop) {
                delayedStop = true;
                // The old worker may finish during ownership checks/termination,
                // but it must never write a later script's wx result file.
                await waitForAbortableDelay(100);
                unadmittedResults.push(
                  ...readdirSync(root).filter(
                    (name) => name === "2.facts.json",
                  ),
                );
              }
              return spawned.cleanup === undefined
                ? cleanupOwnedProcessGroup(spawned.ownership)
                : spawned.cleanup();
            },
          };
        },
      });
      const result = await analyzeWebBundleScripts(
        [small(0), small(1), small(2)],
        {},
        dependencies,
      );
      if (!result.ok) throw result.error.error;
      expect(stalled).toBe(true);
      expect(result.value[1]).toMatchObject({
        status: "resource_limited",
        script_key: small(1).script_key,
        resource: "cpu",
      });
      expect(endpoints(result.value[0])).toEqual(["/api/kept-0"]);
      expect(endpoints(result.value[2])).toEqual(["/api/kept-2"]);
      expect(pids).toHaveLength(2);
      expect(delayedStop).toBe(true);
      expect(unadmittedResults).toEqual([]);
      for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
      await released(dependencies.roots);
    },
    60_000,
  );

  it("reports oversized facts as a capacity limit", async () => {
    const result = await analyzeWebBundleScripts(
      [small(1)],
      {},
      {
        limits: { resultBytes: 16 },
      },
    );
    if (!result.ok) throw result.error.error;
    expect(result.value[0]).toMatchObject({
      status: "resource_limited",
      resource: "capacity",
    });
  }, 60_000);
});

describe("owned web bundle analysis worker lifecycle", () => {
  it("cancels during active analysis with the caller's reason and releases the worker", async () => {
    const controller = new AbortController();
    const reason = new Error("caller stopped analysis");
    let pid: number | undefined;
    const dependencies = tracked({
      launcher: async (options) => {
        const spawned = await spawnOwnedProviderProcess(options);
        pid = spawned.process.pid;
        // The first start frame proves the worker is analyzing, not starting.
        spawned.process.stdout?.on("data", (chunk: Buffer) => {
          if (chunk.toString("utf8").includes('"start"'))
            controller.abort(reason);
        });
        return spawned;
      },
    });
    const result = await analyzeWebBundleScripts(
      [expensive(1)],
      { signal: controller.signal },
      dependencies,
    );
    if (result.ok) throw new Error("expected cancellation");
    expect(result.error.error).toBeInstanceOf(AnalysisCancelledError);
    expect(result.error.error.cause).toBe(reason);
    expect(result.error.completed).toBeUndefined();
    expect(pid).toBeDefined();
    expect(() => process.kill(pid ?? 0, 0)).toThrow();
    await released(dependencies.roots);
  }, 60_000);

  it("waits for parent admission without spending a script's deadline during startup", async () => {
    const factsBeforeAdmission: string[] = [];
    const scripts = Array.from({ length: 40 }, (_, index) =>
      script(index % 10, `fetch("/api/burst-${String(index)}");`),
    ).map((item, index) => ({
      ...item,
      script_key: `scr_${String(index % 10).repeat(64)}_${String(index)}`,
    }));
    const result = await analyzeWebBundleScripts(
      scripts,
      {},
      {
        limits: { scriptTimeoutMs: 500 },
        launcher: async (options) => {
          if (options.cwd === undefined) throw new Error("Missing worker root");
          const spawned = await spawnOwnedProviderProcess(options);
          // The worker is ready, but no script may run before the parent can
          // start its deadline and send its request, even after two seconds.
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2_000);
          factsBeforeAdmission.push(
            ...readdirSync(options.cwd).filter((name) =>
              name.endsWith(".facts.json"),
            ),
          );
          return spawned;
        },
      },
    );
    if (!result.ok) throw result.error.error;
    expect(factsBeforeAdmission).toEqual([]);
    expect(result.value.map(endpoints)).toEqual(
      scripts.map((_, index) => [`/api/burst-${String(index)}`]),
    );
  }, 60_000);

  it("reports an unexplained worker exit as a provider failure", async () => {
    const dependencies = tracked({
      launcher: (options) =>
        spawnOwnedProviderProcess({
          ...options,
          arguments: ["-e", "process.exit(3)"],
        }),
    });
    const result = await analyzeWebBundleScripts([small(1)], {}, dependencies);
    if (result.ok) throw new Error("expected worker failure");
    expect(result.error.error).toBeInstanceOf(ProviderAdapterError);
    expect(result.error.error).toMatchObject({
      diagnostics: { script_index: 0, exit_code: 3 },
    });
    await released(dependencies.roots);
  }, 60_000);

  it("retains a root whose release failed and retries it before the next analysis", async () => {
    let failClose = true;
    const roots: string[] = [];
    const createRuntime = async () => {
      const root = await PrivateRuntimeRoot.create({ prefix: "rea-wb-test-" });
      roots.push(root.path);
      return {
        path: root.path,
        close: async () => {
          if (failClose) throw new Error("injected root release failure");
          await root.close();
        },
      };
    };
    const owner = new WebBundleAnalysisOwner({ createRuntime });
    const first = await owner.analyze([small(1)]);
    if (first.ok) throw new Error("expected cleanup failure");
    expect(first.error.error).toBeInstanceOf(ProviderCleanupError);
    expect(first.error.error).toMatchObject({
      diagnostics: { cleanup_failures: ["injected root release failure"] },
    });
    // The analysis finished before cleanup failed, so its outcome survives.
    expect(endpoints(first.error.completed?.[0])).toEqual(["/api/kept-1"]);
    await access(roots[0] ?? "");
    failClose = false;
    const second = await owner.analyze([small(2)]);
    if (!second.ok) throw second.error.error;
    expect(endpoints(second.value[0])).toEqual(["/api/kept-2"]);
    expect(first.error.error.cleanupIncomplete).toBe(false);
    await owner.close();
    await released(roots);
  }, 60_000);
});

const request = (endpoint: string, allowedOrigin: string) =>
  analyzeWebBundleInputSchema.parse({
    cdp_endpoint: endpoint,
    allowed_origins: [allowedOrigin],
    target_id: "allowed-page",
    observation_ms: 0,
  });

it.each([
  { file: "script", failRoot: false },
  { file: "facts", failRoot: false },
  { file: "script", failRoot: true },
  { file: "facts", failRoot: true },
])(
  "retains accepted findings when final $file removal fails (root retry: $failRoot)",
  async ({ file, failRoot }) => {
    const roots: string[] = [];
    let rootBlocked = failRoot;
    let finalRead = false;
    let replaced = false;
    const originalClose = OwnedFileHandle.prototype.close;
    const close = vi
      .spyOn(OwnedFileHandle.prototype, "close")
      .mockImplementation(async function (this: OwnedFileHandle) {
        await originalClose.call(this);
        if (!finalRead || replaced) return;
        replaced = true;
        // The actual file-removal boundary fails after the stable read finishes.
        const path = join(roots[0] ?? "", `1.${file}.json`);
        await rm(path);
        await mkdir(path);
      });
    const owner = new WebBundleAnalysisOwner({
      createRuntime: async () => {
        const root = await PrivateRuntimeRoot.create({
          prefix: "rea-wb-test-",
        });
        roots.push(root.path);
        return {
          path: root.path,
          close: async () => {
            if (rootBlocked) throw new Error("injected root release failure");
            await root.close();
          },
        };
      },
      launcher: async (options) => {
        const spawned = await spawnOwnedProviderProcess(options);
        spawned.process.stdout?.on("data", (chunk: Buffer) => {
          if (chunk.toString("utf8").includes('"kind":"done","index":1'))
            finalRead = true;
        });
        return spawned;
      },
    });
    try {
      const result = await owner.analyze([small(0), small(1)]);
      if (result.ok) throw new Error("Expected file cleanup failure");
      expect(replaced).toBe(true);
      expect(result.error.completed?.map(endpoints)).toEqual([
        ["/api/kept-0"],
        ["/api/kept-1"],
      ]);
      expect(
        result.error.error.cleanupPrimary ?? result.error.error,
      ).toBeInstanceOf(ProviderCleanupError);
      expect(result.error.error.cleanupIncomplete).toBe(failRoot);
      if (failRoot) {
        await expect(owner.close()).rejects.toBeInstanceOf(
          ProviderCleanupError,
        );
        await access(roots[0] ?? "");
      }
      rootBlocked = false;
      await owner.close();
      expect(result.error.error.cleanupIncomplete).toBe(false);
      expect(result.error.error.cleanupResources).toEqual([]);
      await released(roots);
    } finally {
      rootBlocked = false;
      await owner.close();
      close.mockRestore();
    }
  },
  60_000,
);

it("preserves returned-reference widening through the real worker boundary", async () => {
  const widened = script(
    0,
    `
    function expose() { return Map.prototype; }
    let cursor = { target: expose };
    function walk(flag) {
      while (flag) cursor = cursor.next;
      patch(cursor.target());
    }
    new Map().get('/candidate');
    fetch('/preserved');
  `,
  );
  const result = await analyzeWebBundleScripts([widened, small(1)], {});
  if (!result.ok) throw result.error.error;
  expect(result.value).toMatchObject([
    { status: "analyzed", facts: { returned_reference_widened: true } },
    { status: "analyzed", facts: { returned_reference_widened: false } },
  ]);
  expect(result.value.map(endpoints)).toEqual([
    ["/preserved"],
    ["/api/kept-1"],
  ]);
}, 60_000);

it.each([false, true])(
  "serializes acquisitions and preserves queue order when cancellation is %s",
  async (cancelQueued) => {
    const acquired = deferred();
    const resume = deferred();
    const controller = new AbortController();
    const reason = new Error("cancel queued analysis");
    let liveRoots = 0;
    let maximumRoots = 0;
    const roots: string[] = [];
    const owner = new WebBundleAnalysisOwner({
      createRuntime: async () => {
        const root = await PrivateRuntimeRoot.create({
          prefix: "rea-wb-test-",
        });
        roots.push(root.path);
        liveRoots += 1;
        maximumRoots = Math.max(maximumRoots, liveRoots);
        if (roots.length === 1) {
          acquired.resolve();
          await resume.promise;
        }
        return {
          path: root.path,
          close: async () => {
            await root.close();
            liveRoots -= 1;
          },
        };
      },
    });
    const first = owner.analyze([small(0)]);
    await acquired.promise;
    const second = owner.analyze([small(1)], { signal: controller.signal });
    const third = owner.analyze([small(2)]);
    try {
      if (cancelQueued) {
        controller.abort(reason);
        const cancelled = await second;
        if (cancelled.ok) throw new Error("Queued cancellation was ignored");
        expect(cancelled.error.error).toBeInstanceOf(AnalysisCancelledError);
        expect(cancelled.error.error.cause).toBe(reason);
      }
      await waitForAbortableDelay(50);
      expect(roots).toHaveLength(1);
      if (cancelQueued) {
        const closing = owner.close();
        resume.resolve();
        await closing;
        expect((await first).ok).toBe(false);
        expect((await third).ok).toBe(false);
        expect(roots).toHaveLength(1);
      } else {
        resume.resolve();
        const results = await Promise.all([first, second, third]);
        for (const [index, result] of results.entries()) {
          if (!result.ok) throw result.error.error;
          expect(endpoints(result.value[0])).toEqual([
            `/api/kept-${String(index)}`,
          ]);
        }
        expect(roots).toHaveLength(3);
      }
      expect(maximumRoots).toBe(1);
      await released(roots);
    } finally {
      resume.resolve();
      await owner.close();
      await Promise.all([first, second, third]);
    }
  },
  60_000,
);

it.each(["cancel", "failure"])(
  "preserves the primary %s alongside failed cleanup",
  async (kind) => {
    const controller = new AbortController();
    const reason = new Error("original caller reason");
    const primary = new AnalysisOutputError(
      "analyze_web_bundle",
      "original protocol failure",
      {
        cause: reason,
        diagnostics: { phase: "fixture" },
      },
    );
    let allowCleanup = false;
    const roots: string[] = [];
    const owner = new WebBundleAnalysisOwner({
      createRuntime: async () => {
        const root = await PrivateRuntimeRoot.create({
          prefix: "rea-wb-test-",
        });
        roots.push(root.path);
        if (kind === "cancel") controller.abort(reason);
        return {
          path: root.path,
          close: async () => {
            if (!allowCleanup) throw new Error("injected root release failure");
            await root.close();
          },
        };
      },
      launcher: async () => {
        throw primary;
      },
    });
    try {
      const result = await owner.analyze([small(0)], {
        signal: controller.signal,
      });
      if (result.ok) throw new Error("Expected analysis and cleanup failures");
      const error = result.error.error;
      expect(error.cleanupIncomplete).toBe(true);
      expect(error.cause).toBeInstanceOf(AggregateError);
      if (kind === "cancel") {
        expect(error.cleanupPrimary).toBeInstanceOf(AnalysisCancelledError);
        expect(error.cleanupPrimary?.cause).toBe(reason);
      } else {
        expect(error.cleanupPrimary).toBe(primary);
        expect(error.cleanupPrimary?.diagnostics).toEqual({ phase: "fixture" });
      }
      allowCleanup = true;
      await owner.close();
      expect(error.cleanupIncomplete).toBe(false);
      expect(resolvedAnalysisError(error)).toBe(error.cleanupPrimary);
      await released(roots);
    } finally {
      allowCleanup = true;
      await owner.close();
    }
  },
  60_000,
);

it("retains failed facts descriptors and closes them before removing the root", async () => {
  let armClose = false;
  let allowCleanup = false;
  let retained: OwnedFileHandle | undefined;
  let rootCloses = 0;
  const roots: string[] = [];
  const originalClose = OwnedFileHandle.prototype.close;
  const close = vi
    .spyOn(OwnedFileHandle.prototype, "close")
    .mockImplementation(async function (this: OwnedFileHandle) {
      if (armClose) retained ??= this;
      if (this === retained && !allowCleanup)
        throw new Error("injected facts descriptor close failure");
      await originalClose.call(this);
    });
  const owner = new WebBundleAnalysisOwner({
    createRuntime: async () => {
      const root = await PrivateRuntimeRoot.create({ prefix: "rea-wb-test-" });
      roots.push(root.path);
      return {
        path: root.path,
        close: async () => {
          rootCloses += 1;
          await root.close();
        },
      };
    },
    launcher: async (options) => {
      const spawned = await spawnOwnedProviderProcess(options);
      spawned.process.stdout?.on("data", (chunk: Buffer) => {
        if (chunk.toString("utf8").includes('"done"')) armClose = true;
      });
      return spawned;
    },
  });
  try {
    const result = await owner.analyze([small(0)]);
    if (result.ok) throw new Error("Expected descriptor cleanup failure");
    expect(result.error.error.cleanupIncomplete).toBe(true);
    expect(retained?.handle.fd).toBeGreaterThanOrEqual(0);
    expect(result.error.error.cleanupResources).toContain(
      join(roots[0] ?? "", "0.facts.json"),
    );
    expect(rootCloses).toBe(0);
    await expect(owner.close()).rejects.toBeInstanceOf(ProviderCleanupError);
    expect(rootCloses).toBe(0);
    allowCleanup = true;
    await owner.close();
    expect(retained?.handle.fd).toBe(-1);
    expect(rootCloses).toBe(1);
    expect(result.error.error.cleanupIncomplete).toBe(false);
    await released(roots);
  } finally {
    allowCleanup = true;
    await owner.close();
    if (retained !== undefined && retained.handle.fd >= 0)
      await originalClose.call(retained);
    close.mockRestore();
  }
}, 60_000);

it("cancels active analysis at provider shutdown and retains an unverified stop for retry", async () => {
  const browser = await startFakeCdpBrowser();
  trackBrowser(browser);
  const started = deferred();
  let allowCleanup = false;
  let pid: number | undefined;
  let launches = 0;
  const dependencies = tracked({
    launcher: async (options) => {
      launches += 1;
      // Keep the owned process alive after its genuine start frame, even if
      // the small captured script finishes before the provider closes.
      const worker = options.arguments[4];
      if (worker === undefined) throw new Error("Missing worker entry");
      const spawned = await spawnOwnedProviderProcess({
        ...options,
        arguments: [
          ...options.arguments.slice(0, 4),
          "--input-type=module",
          "-e",
          `import { pathToFileURL } from 'node:url'; process.argv.splice(1, 0, ${JSON.stringify(worker)}); const keepAlive = setInterval(() => {}, 1000); await import(pathToFileURL(${JSON.stringify(worker)}).href);`,
          ...options.arguments.slice(5),
        ],
      });
      pid = spawned.process.pid;
      spawned.process.stdout?.on("data", (chunk: Buffer) => {
        if (chunk.toString("utf8").includes('"start"')) started.resolve();
      });
      return {
        ...spawned,
        cleanup: () =>
          allowCleanup
            ? spawned.cleanup === undefined
              ? cleanupOwnedProcessGroup(spawned.ownership)
              : spawned.cleanup()
            : Promise.resolve({
                cleaned: false as const,
                reason: "injected worker stop failure",
              }),
      };
    },
  });
  const owner = new WebBundleAnalysisOwner(dependencies);
  const provider = new CdpBrowserProvider(owner);
  const pending = provider.analyzeBundle(
    request(browser.endpoint, browser.allowedOrigin),
  );
  try {
    await started.promise;
    await expect(provider.close()).rejects.toBeInstanceOf(ProviderCleanupError);
    const result = await pending;
    if (result.ok) throw new Error("Expected cancellation with failed cleanup");
    expect(result.error.cleanupIncomplete).toBe(true);
    expect(pid).toBeDefined();
    expect(() => process.kill(pid ?? 0, 0)).not.toThrow();
    for (const root of dependencies.roots) await access(root);
    allowCleanup = true;
    await provider.close();
    expect(result.error.cleanupIncomplete).toBe(false);
    expect(() => process.kill(pid ?? 0, 0)).toThrow();
    await released(dependencies.roots);
    const rejected = await owner.analyze([small(0)]);
    if (rejected.ok) throw new Error("Closed provider admitted another worker");
    expect(rejected.error.error).toBeInstanceOf(AnalysisCancelledError);
    expect(launches).toBe(1);
  } finally {
    allowCleanup = true;
    await provider.close();
    await pending;
  }
}, 60_000);

it("retries failed private-root cleanup at shutdown without involving another provider", async () => {
  const browser = await startFakeCdpBrowser();
  trackBrowser(browser);
  let allowCleanup = false;
  let releases = 0;
  const roots: string[] = [];
  const owner = new WebBundleAnalysisOwner({
    createRuntime: async () => {
      const root = await PrivateRuntimeRoot.create({
        prefix: "rea-wb-test-",
      });
      roots.push(root.path);
      return {
        path: root.path,
        close: async () => {
          releases += 1;
          if (!allowCleanup) throw new Error("injected root release failure");
          await root.close();
        },
      };
    },
  });
  const provider = new CdpBrowserProvider(owner);
  try {
    const result = await provider.analyzeBundle(
      request(browser.endpoint, browser.allowedOrigin),
    );
    if (result.ok) throw new Error("Expected retained root");
    expect(result.error).toBeInstanceOf(ProviderCleanupError);
    expect(releases).toBe(1);
    // A separate lifetime neither retries nor inherits this failure.
    const peer = await analyzeWebBundleScripts([small(1)], {});
    if (!peer.ok) throw peer.error.error;
    expect(releases).toBe(1);
    await expect(provider.close()).rejects.toBeInstanceOf(ProviderCleanupError);
    expect(releases).toBe(2);
    for (const root of roots) await access(root);
    allowCleanup = true;
    await provider.close();
    expect(releases).toBe(3);
    expect(result.error.cleanupIncomplete).toBe(false);
    await released(roots);
  } finally {
    allowCleanup = true;
    await provider.close();
  }
}, 60_000);

it("waits for an in-flight root acquisition before completing provider shutdown", async () => {
  const acquired = deferred();
  const resume = deferred();
  const roots: string[] = [];
  const owner = new WebBundleAnalysisOwner({
    createRuntime: async () => {
      const root = await PrivateRuntimeRoot.create({
        prefix: "rea-wb-test-",
      });
      roots.push(root.path);
      acquired.resolve();
      await resume.promise;
      return root;
    },
  });
  const provider = new CdpBrowserProvider(owner);
  const pending = owner.analyze([small(0)]);
  try {
    await acquired.promise;
    let closed = false;
    const closing = provider.close().then(() => {
      closed = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(closed).toBe(false);
    resume.resolve();
    await closing;
    const result = await pending;
    if (result.ok) throw new Error("Expected shutdown cancellation");
    expect(result.error.error).toBeInstanceOf(AnalysisCancelledError);
    await released(roots);
  } finally {
    resume.resolve();
    await provider.close();
    await pending;
  }
}, 60_000);

it("projects injected memory-limit outcomes as partial analysis on every runtime", async () => {
  const browser = await startFakeCdpBrowser();
  trackBrowser(browser);
  const provider = new CdpBrowserProvider(
    recordingAnalyzer(async (scripts) =>
      ok(
        scripts.map(({ script_key }) => ({
          status: "resource_limited" as const,
          script_key,
          resource: "memory" as const,
          reason: "Static analysis of this script exhausted the worker heap.",
        })),
      ),
    ),
  );
  const result = await provider.analyzeBundle(
    request(browser.endpoint, browser.allowedOrigin),
  );
  if (!result.ok) throw result.error;
  expect(result.value.capture.scripts_analyzed).toBeGreaterThan(0);
  expect(result.value.completeness.status).toBe("partial");
  expect(result.value.unknowns).toContainEqual(
    expect.objectContaining({ dimension: "javascript_analysis" }),
  );
});

it("keeps the captured inspection on analyzer cancellation", async () => {
  const browser = await startFakeCdpBrowser();
  trackBrowser(browser);
  const cancelled = new AnalysisCancelledError("analyze_web_bundle", {
    cause: new Error("caller reason"),
  });
  const provider = new CdpBrowserProvider(
    recordingAnalyzer(async () => err({ error: cancelled })),
  );
  const result = await provider.analyzeBundle(
    request(browser.endpoint, browser.allowedOrigin),
  );
  if (result.ok) throw new Error("expected cancellation");
  expect(result.error).toBe(cancelled);
  expect(result.error.partialObservation).toMatchObject({
    target: { target_id: "allowed-page" },
  });
});

it("keeps a completed analysis as partial Evidence when cleanup fails afterwards", async () => {
  const browser = await startFakeCdpBrowser();
  trackBrowser(browser);
  const cleanup = new ProviderCleanupError("web-bundle-analysis", ["run"], {
    reason: "injected",
  });
  const provider = new CdpBrowserProvider(
    recordingAnalyzer(async (scripts) =>
      err({
        error: cleanup,
        completed: scripts.map((item) => ({
          status: "analyzed" as const,
          facts: analyzeWebBundleScript(item),
        })),
      }),
    ),
  );
  const result = await analyzeWebBundle(
    provider,
    request(browser.endpoint, browser.allowedOrigin),
  );
  if (result.ok) throw new Error("expected cleanup failure");
  expect(result.error).toBe(cleanup);
  expect(parseEvidence(result.error.partialObservation)).toMatchObject({
    operation: "analyze_web_bundle",
    normalized_result: { completeness: { status: "complete" } },
  });
});
