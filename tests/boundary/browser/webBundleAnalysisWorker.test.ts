import { access } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { CdpBrowserProvider } from "../../../src/browser/CdpBrowserProvider.js";
import { analyzeWebBundle } from "../../../src/application/BrowserObservationService.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { ProviderCleanupError } from "../../../src/domain/providerCleanupError.js";
import { analyzeWebBundleScript } from "../../../src/domain/webBundleAnalyzerInspection.js";
import { AnalysisCancelledError } from "../../../src/domain/analysisErrorCore.js";
import { err, ok } from "../../../src/domain/result.js";
import { analyzeWebBundleInputSchema } from "../../../src/domain/webBundleAnalysis.js";
import { startFakeCdpBrowser } from "../../fixtures/fakeCdpBrowser.js";
import { trackBrowser } from "./cdpBrowserProvider.support.js";
import { ProviderAdapterError } from "../../../src/domain/providerAdapterError.js";
import type { IncludedScript } from "../../../src/domain/webBundleAnalyzerInspection.js";
import { createWebTextArtifact } from "../../../src/domain/webContentArtifact.js";
import {
  analyzeWebBundleScripts,
  WebBundleAnalysisCleanupFailure,
  type WebBundleAnalysisWorkerDependencies,
} from "../../../src/browser/WebBundleAnalysisWorker.js";
import { PrivateRuntimeRoot } from "../../../src/process/PrivateRuntimeRoot.js";
import { spawnOwnedProviderProcess } from "../../../src/process/ProviderProcess.js";

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

describe("owned web bundle analysis worker bounds", () => {
  it("reports heap exhaustion for one script and keeps the others", async () => {
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
  }, 60_000);

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

  it("keeps every frame from many scripts while the parent is stalled", async () => {
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
        launcher: async (options) => {
          const spawned = await spawnOwnedProviderProcess(options);
          // Block the parent event loop while the worker emits every frame.
          const until = Date.now() + 2_000;
          while (Date.now() < until);
          return spawned;
        },
      },
    );
    if (!result.ok) throw result.error.error;
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
    const first = await analyzeWebBundleScripts(
      [small(1)],
      {},
      {
        createRuntime,
      },
    );
    if (first.ok) throw new Error("expected cleanup failure");
    expect(first.error.error).toBeInstanceOf(WebBundleAnalysisCleanupFailure);
    expect(first.error.error).toMatchObject({
      diagnostics: { cleanup_failures: ["injected root release failure"] },
    });
    // The analysis finished before cleanup failed, so its outcome survives.
    expect(endpoints(first.error.completed?.[0])).toEqual(["/api/kept-1"]);
    await access(roots[0] ?? "");
    failClose = false;
    const second = await analyzeWebBundleScripts(
      [small(2)],
      {},
      {
        createRuntime,
      },
    );
    if (!second.ok) throw second.error.error;
    expect(endpoints(second.value[0])).toEqual(["/api/kept-2"]);
    await released(roots);
  }, 60_000);
});

describe("CdpBrowserProvider bundle analysis through the owned analyzer", () => {
  const request = (endpoint: string, allowedOrigin: string) =>
    analyzeWebBundleInputSchema.parse({
      cdp_endpoint: endpoint,
      allowed_origins: [allowedOrigin],
      target_id: "allowed-page",
      observation_ms: 0,
    });

  it("projects a resource-limited script as a partial analysis", async () => {
    const browser = await startFakeCdpBrowser();
    trackBrowser(browser);
    const provider = new CdpBrowserProvider(async (scripts) =>
      ok(
        scripts.map(({ script_key }) => ({
          status: "resource_limited" as const,
          script_key,
          resource: "memory" as const,
          reason: "Static analysis of this script exhausted the worker heap.",
        })),
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
    const provider = new CdpBrowserProvider(async () =>
      err({ error: cancelled }),
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
    const provider = new CdpBrowserProvider(async (scripts) =>
      err({
        error: cleanup,
        completed: scripts.map((item) => ({
          status: "analyzed" as const,
          facts: analyzeWebBundleScript(item),
        })),
      }),
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
});
