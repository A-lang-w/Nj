import { expect, it } from "vitest";
import { AnalysisResourceConstraintError } from "../analysisErrorCore.js";
import { projectAnalysisError } from "../analysisErrorProjection.js";
import {
  JAVASCRIPT_ANALYSIS_RESOURCE_DEFAULTS,
  JAVASCRIPT_SEMANTIC_ITEM_MAXIMUM,
  JAVASCRIPT_WORKER_HEAP_MIB_MAXIMUM,
  JAVASCRIPT_WORKER_HEAP_MIB_MINIMUM,
  javaScriptAnalysisResourceControlsSchema,
  javaScriptSemanticCeilingCoverage,
  javaScriptWorkerHeapRemediation,
} from "./javascriptAnalysisResourceControls.js";

it("keeps omitted operational choices absent and validates explicit semantic budgets", () => {
  expect(javaScriptAnalysisResourceControlsSchema.parse({})).toEqual({});
  expect(
    javaScriptAnalysisResourceControlsSchema.parse({
      max_semantic_nodes: 750_000,
      max_semantic_nodes_per_file: 700_000,
      max_semantic_unknowns: 500_000,
      max_semantic_unknowns_per_file: 400_000,
    }),
  ).toEqual({
    max_semantic_nodes: 750_000,
    max_semantic_nodes_per_file: 700_000,
    max_semantic_unknowns: 500_000,
    max_semantic_unknowns_per_file: 400_000,
  });
  for (const value of [0, -1, 1.5, 1_000_001, Infinity, NaN]) {
    for (const key of [
      "max_semantic_nodes",
      "max_semantic_nodes_per_file",
      "max_semantic_unknowns",
      "max_semantic_unknowns_per_file",
    ])
      expect(
        javaScriptAnalysisResourceControlsSchema.safeParse({ [key]: value })
          .success,
      ).toBe(false);
  }
});

it("names max_heap_mb, its range, and the budgets it does not raise", () => {
  const heapMb = JAVASCRIPT_ANALYSIS_RESOURCE_DEFAULTS.heapMb;
  const error = new AnalysisResourceConstraintError(
    "analyze_javascript_application",
    "memory",
    `Owned JavaScript worker exhausted its ${String(heapMb)} MiB V8 old-space heap (max_heap_mb) while analyzing app.js during static`,
    { worker_old_space_mb: heapMb },
    { remediationAction: javaScriptWorkerHeapRemediation(heapMb) },
  );
  const projected = projectAnalysisError(error);
  expect(projected.message).toContain(`max_heap_mb`);
  expect(projected.message).toContain(`${String(heapMb)} MiB`);
  expect(projected.remediation.action).toContain("max_heap_mb");
  expect(projected.remediation.action).toContain(
    String(JAVASCRIPT_WORKER_HEAP_MIB_MINIMUM),
  );
  expect(projected.remediation.action).toContain(
    String(JAVASCRIPT_WORKER_HEAP_MIB_MAXIMUM),
  );
  expect(projected.remediation.action).toContain("--max-heap-mb");
  expect(projected.remediation.action).toContain("next analysis");
  expect(projected.remediation.action).toContain("new worker");
  expect(projected.remediation.action).toContain("parent result budget");
  expect(projected.remediation.action).toContain("transfer");
  expect(projected.remediation.action).not.toMatch(/available host memory/u);
  const maximum = projectAnalysisError(
    new AnalysisResourceConstraintError(
      "analyze_javascript_application",
      "memory",
      "heap",
      null,
      {
        remediationAction: javaScriptWorkerHeapRemediation(
          JAVASCRIPT_WORKER_HEAP_MIB_MAXIMUM,
        ),
      },
    ),
  );
  expect(maximum.remediation.action).toContain("Do not increase it further");
});

it("names the four semantic arguments on ceiling coverage", () => {
  const nodes = javaScriptSemanticCeilingCoverage("nodes", 50, 30);
  const unknowns = javaScriptSemanticCeilingCoverage("unknowns", 3, 2);
  expect(nodes.limits).toEqual(
    expect.arrayContaining([
      { name: "semantic_graph_node_ceiling", value: 50, unit: "items" },
      { name: "semantic_graph_file_node_ceiling", value: 30, unit: "items" },
      { name: "max_semantic_nodes", value: 50, unit: "items" },
      { name: "max_semantic_nodes_per_file", value: 30, unit: "items" },
    ]),
  );
  expect(unknowns.limits).toEqual(
    expect.arrayContaining([
      { name: "semantic_graph_unknown_ceiling", value: 3, unit: "items" },
      { name: "semantic_graph_file_unknown_ceiling", value: 2, unit: "items" },
      { name: "max_semantic_unknowns", value: 3, unit: "items" },
      { name: "max_semantic_unknowns_per_file", value: 2, unit: "items" },
    ]),
  );
  expect(nodes.limitation).toContain("1 to");
  expect(nodes.limitation).toContain(String(JAVASCRIPT_SEMANTIC_ITEM_MAXIMUM));
  expect(nodes.limitation).toContain("--max-semantic-nodes");
  expect(nodes.limitation).toContain("next analysis");
  expect(unknowns.limitation).toContain("--max-semantic-unknowns");
  expect(unknowns.limitation).toContain("max_semantic_nodes");
  const capped = javaScriptSemanticCeilingCoverage(
    "nodes",
    JAVASCRIPT_SEMANTIC_ITEM_MAXIMUM,
    JAVASCRIPT_SEMANTIC_ITEM_MAXIMUM,
  );
  expect(capped.limitation).toContain("Do not increase it further");
});
