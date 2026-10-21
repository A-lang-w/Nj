import { spawnSync } from "node:child_process";

import { expect, it } from "vitest";

import { ok } from "../../../src/domain/result.js";
import { HopperRegexSearch } from "../../../src/hopper/HopperRegexSearch.js";
import { OFFICIAL_TOOL_CONTRACTS } from "../../../src/contracts/officialToolContracts.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import {
  matchRegexValues,
  REGEX_MATCHING_LIMITATION,
  regexMatchingDeadlineError,
  regexMatchingLimitation,
  regexWorkerHeapError,
  resolveRegexWorkerHeap,
} from "../../../src/process/RegexMatcher.js";

const workerHeapProbe = `
import { Worker } from "node:worker_threads";
const worker = new Worker(
  \`import { parentPort, resourceLimits } from "node:worker_threads";
    import v8 from "node:v8";
    parentPort.postMessage({
      resourceOld: resourceLimits.maxOldGenerationSizeMb,
      heap: v8.getHeapStatistics().heap_size_limit,
    });\`,
  { eval: true, resourceLimits: { maxOldGenerationSizeMb: 128 } },
);
worker.once("message", (message) => {
  process.stdout.write(JSON.stringify(message));
  void worker.terminate();
});
worker.once("error", (error) => {
  process.stderr.write(error.message);
  process.exitCode = 1;
});
`;

const probeWorkerHeap = (
  args: readonly string[],
  nodeOptions: string | undefined,
): { readonly resourceOld: number; readonly heap: number } => {
  const env = { ...process.env };
  if (nodeOptions === undefined) delete env.NODE_OPTIONS;
  else env.NODE_OPTIONS = nodeOptions;
  const result = spawnSync(process.execPath, [...args, "-e", workerHeapProbe], {
    env,
    encoding: "utf8",
  });
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout ?? "") as {
    resourceOld: number;
    heap: number;
  };
};

it("names the fixed regex deadline and the effective worker heap", () => {
  const heap = resolveRegexWorkerHeap(
    process.execArgv,
    process.env.NODE_OPTIONS,
  );
  expect(REGEX_MATCHING_LIMITATION).toBe(regexMatchingLimitation(heap));
  expect(REGEX_MATCHING_LIMITATION).toContain("5-second matching deadline");
  expect(REGEX_MATCHING_LIMITATION).toContain(
    "This release has no runtime override for the deadline.",
  );
  expect(REGEX_MATCHING_LIMITATION).not.toContain("either cap");
  expect(REGEX_MATCHING_LIMITATION).not.toContain("or heap");
  if (heap.kind === "unknown") {
    expect(REGEX_MATCHING_LIMITATION).toContain("was not established");
  } else {
    expect(REGEX_MATCHING_LIMITATION).toContain(
      `effective ${String(heap.mib)} MiB`,
    );
  }
  const deadline = projectAnalysisError(
    regexMatchingDeadlineError("search_procedures"),
  );
  expect(deadline.message).toContain("5000 ms");
  expect(deadline.remediation.action).toContain(
    "this release has no runtime override",
  );
  const failure = projectAnalysisError(
    regexWorkerHeapError("search_procedures", new Error("heap")),
  );
  expect(failure.remediation.action).not.toContain("no runtime override");
  expect(failure.remediation.action).toContain("--max-old-space-size");
  if (heap.kind === "effective") {
    expect(failure.message).toContain(`${String(heap.mib)} MiB`);
    expect(failure.details).toMatchObject({
      reported_limits: {
        worker_heap_mib: heap.mib,
        requested_worker_heap_mib: 128,
      },
    });
  } else {
    expect(failure.message).toContain("was not established");
    expect(failure.details).toMatchObject({
      reported_limits: { requested_worker_heap_mib: 128 },
    });
  }
  for (const name of ["search_procedures", "search_strings"] as const) {
    const description = OFFICIAL_TOOL_CONTRACTS.find(
      (tool) => tool.name === name,
    )?.description;
    expect(description).toContain("5000 ms");
    expect(description).toContain("no runtime override");
  }
});

it("lets a launch --max-old-space-size override the 128 MiB worker request", () => {
  const baseline = probeWorkerHeap([], undefined);
  const smaller = probeWorkerHeap(["--max-old-space-size=64"], undefined);
  const larger = probeWorkerHeap([], "--max-old-space-size=256");
  expect(baseline.resourceOld).toBe(128);
  expect(smaller.resourceOld).toBe(128);
  expect(larger.resourceOld).toBe(128);
  expect(smaller.heap).toBeLessThan(baseline.heap);
  expect(larger.heap).toBeGreaterThan(baseline.heap);
});

it("preserves Unicode matching order and refuses a pre-cancelled match", async () => {
  expect(
    await matchRegexValues({
      operation: "search_procedures",
      pattern: "^δ",
      caseSensitive: false,
      values: ["Δelta", "delta", "δίκη"],
    }),
  ).toEqual(ok([0, 2]));
  expect(
    await matchRegexValues({
      operation: "search_procedures",
      pattern: ".",
      caseSensitive: true,
      values: ["value"],
      signal: AbortSignal.abort(),
    }),
  ).toMatchObject({ ok: false, error: { _tag: "AnalysisCancelledError" } });
});

it("keeps Hopper's result projection and invalid-pattern contract with the shared worker", async () => {
  const search = new HopperRegexSearch({
    callTool: async () =>
      ok([
        { address: "0x10", value: "Δelta" },
        { address: "0x20", value: "other" },
      ]),
  });
  expect(
    await search.execute("search_strings", { pattern: "^δ", mode: "regex" }),
  ).toEqual(ok([{ address: "0x10", value: "Δelta" }]));
  expect(
    await search.execute("search_strings", { pattern: "[", mode: "regex" }),
  ).toMatchObject({
    ok: false,
    error: {
      _tag: "HopperRemoteError",
      code: -32000,
      diagnosticType: "invalid_request",
      operation: "search_strings",
    },
  });
  await search.close();
});
