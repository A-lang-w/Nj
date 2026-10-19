import { access } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { CdpBrowserProvider } from "../../../src/browser/CdpBrowserProvider.js";
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

describe("owned web bundle analysis worker", () => {
  it("reports heap exhaustion for one script and keeps the others", async () => {
    const dependencies = tracked({ limits: { heapMb: 96 } });
    const result = await analyzeWebBundleScripts(
      [small(1), expensive(2), small(3)],
      {},
      dependencies,
    );
    if (!result.ok) throw result.error;
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
    if (!result.ok) throw result.error;
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
    if (!result.ok) throw result.error;
    expect(result.value[0]).toMatchObject({
      status: "resource_limited",
      resource: "capacity",
    });
  }, 60_000);

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
    expect(result.error).toBeInstanceOf(AnalysisCancelledError);
    expect(result.error.cause).toBe(reason);
    expect(pid).toBeDefined();
    expect(() => process.kill(pid ?? 0, 0)).toThrow();
    await released(dependencies.roots);
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
    expect(result.error).toBeInstanceOf(ProviderAdapterError);
    expect(result.error).toMatchObject({
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
    expect(first.error).toBeInstanceOf(WebBundleAnalysisCleanupFailure);
    expect(first.error).toMatchObject({
      diagnostics: { cleanup_failures: ["injected root release failure"] },
    });
    await access(roots[0] ?? "");
    failClose = false;
    const second = await analyzeWebBundleScripts(
      [small(2)],
      {},
      {
        createRuntime,
      },
    );
    if (!second.ok) throw second.error;
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
    const provider = new CdpBrowserProvider(async () => err(cancelled));
    const result = await provider.analyzeBundle(
      request(browser.endpoint, browser.allowedOrigin),
    );
    if (result.ok) throw new Error("expected cancellation");
    expect(result.error).toBe(cancelled);
    expect(result.error.partialObservation).toMatchObject({
      target: { target_id: "allowed-page" },
    });
  });
});
