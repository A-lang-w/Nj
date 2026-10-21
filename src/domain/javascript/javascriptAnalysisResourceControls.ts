import { z } from "zod";
import type { JsonValue } from "../jsonValue.js";
import type { ApplicationCoverage } from "./javascriptApplicationEvidenceSchemas.js";

/** Shared operational defaults for the isolated source-analysis boundary. */
export const JAVASCRIPT_ANALYSIS_RESOURCE_DEFAULTS = {
  heapMb: 1024,
  timeoutMs: 300_000,
  semanticNodes: 100_000,
  semanticNodesPerFile: 20_000,
  semanticUnknowns: 100_000,
  semanticUnknownsPerFile: 20_000,
} as const;

/** Inclusive `max_heap_mb` range. The worker reads it only when that process starts. */
export const JAVASCRIPT_WORKER_HEAP_MIB_MINIMUM = 128;
export const JAVASCRIPT_WORKER_HEAP_MIB_MAXIMUM = 16_384;

/** Maximum caller-selected retained record capacity; heap and transfer admission still apply. */
export const JAVASCRIPT_SEMANTIC_ITEM_MAXIMUM = 1_000_000;

const HEAP_DOES_NOT_RAISE =
  "Raising max_heap_mb does not raise the parent result budget, transfer record or transfer file byte ceilings, the CLI/MCP process heap, or fixed parser limits.";

/**
 * Recovery for the isolated analyzer heap. A changed value applies on the next
 * analysis because the V8 flag is fixed at worker launch and a different heap
 * is not reused.
 */
export const javaScriptWorkerHeapRemediation = (heapMb: number): string => {
  const bounds = `an integer from ${String(JAVASCRIPT_WORKER_HEAP_MIB_MINIMUM)} to ${String(JAVASCRIPT_WORKER_HEAP_MIB_MAXIMUM)} (default ${String(JAVASCRIPT_ANALYSIS_RESOURCE_DEFAULTS.heapMb)} MiB)`;
  const adjustment =
    heapMb >= JAVASCRIPT_WORKER_HEAP_MIB_MAXIMUM
      ? `max_heap_mb is already ${String(heapMb)} MiB, the maximum ${String(JAVASCRIPT_WORKER_HEAP_MIB_MAXIMUM)}. Do not increase it further.`
      : `Increase max_heap_mb (CLI: rea analyze-javascript-application <input_path> --max-heap-mb <mebibytes>), ${bounds}.`;
  return `${adjustment} The effective worker heap for this analysis is ${String(heapMb)} MiB. A changed max_heap_mb applies on the next analysis, which starts a new worker. It does not change a worker that is already running, and it does not require restarting the REA server. ${HEAP_DOES_NOT_RAISE} On Bun, V8 heap flags are ignored: Windows limits the analyzer's committed memory to max_heap_mb plus a 512 MiB reserve, and other Bun hosts enforce no analyzer heap limit.`;
};

/** Parent admission is independent of the isolated worker heap argument. */
export const JAVASCRIPT_PARENT_RESULT_BUDGET_REMEDIATION =
  "This limit belongs to the parent result budget. Increasing max_heap_mb does not raise it, and this release has no runtime override for that parent budget. Use the retained static facts or analyze fewer source files.";

const semanticControl = {
  nodes: {
    total: "max_semantic_nodes",
    perFile: "max_semantic_nodes_per_file",
    ceiling: "semantic_graph_node_ceiling",
    fileCeiling: "semantic_graph_file_node_ceiling",
    totalDefault: JAVASCRIPT_ANALYSIS_RESOURCE_DEFAULTS.semanticNodes,
    perFileDefault: JAVASCRIPT_ANALYSIS_RESOURCE_DEFAULTS.semanticNodesPerFile,
    cli: "--max-semantic-nodes and --max-semantic-nodes-per-file",
    unaffected:
      "Raising them does not raise max_semantic_unknowns, max_heap_mb, transfer ceilings, or the parent result budget.",
  },
  unknowns: {
    total: "max_semantic_unknowns",
    perFile: "max_semantic_unknowns_per_file",
    ceiling: "semantic_graph_unknown_ceiling",
    fileCeiling: "semantic_graph_file_unknown_ceiling",
    totalDefault: JAVASCRIPT_ANALYSIS_RESOURCE_DEFAULTS.semanticUnknowns,
    perFileDefault:
      JAVASCRIPT_ANALYSIS_RESOURCE_DEFAULTS.semanticUnknownsPerFile,
    cli: "--max-semantic-unknowns and --max-semantic-unknowns-per-file",
    unaffected:
      "Raising them does not raise max_semantic_nodes, max_heap_mb, transfer ceilings, or the parent result budget.",
  },
} as const;

const semanticAdjustment = (
  name: string,
  value: number,
  fallback: number,
): string =>
  value >= JAVASCRIPT_SEMANTIC_ITEM_MAXIMUM
    ? `${name} is already ${String(value)}, the maximum ${String(JAVASCRIPT_SEMANTIC_ITEM_MAXIMUM)}. Do not increase it further.`
    : `${name} is ${String(value)} (default ${String(fallback)}; an integer from 1 to ${String(JAVASCRIPT_SEMANTIC_ITEM_MAXIMUM)})`;

/** Name the caller arguments that produced one semantic retention ceiling. */
export const javaScriptSemanticCeilingCoverage = (
  kind: "nodes" | "unknowns",
  total: number,
  perFile: number,
): {
  readonly limits: ApplicationCoverage["limits"];
  readonly limitation: string;
} => {
  const control = semanticControl[kind];
  const limits: ApplicationCoverage["limits"] = [
    { name: control.ceiling, value: total, unit: "items" },
    { name: control.fileCeiling, value: perFile, unit: "items" },
    { name: control.total, value: total, unit: "items" },
    { name: control.perFile, value: perFile, unit: "items" },
  ];
  const limitation = `Semantic ${kind === "nodes" ? "node" : "unknown"} retention reached ${semanticAdjustment(control.total, total, control.totalDefault)} and ${semanticAdjustment(control.perFile, perFile, control.perFileDefault)}. Set ${control.total} and ${control.perFile} on the next analyze_javascript_application call (CLI: ${control.cli}). The change applies to that next analysis and does not restart the worker or the REA server. ${control.unaffected} Coverage reports the same effective values as ${control.ceiling} and ${control.fileCeiling}.`;
  return { limits, limitation };
};

/** Project observed execution limits without inventing unmeasured values. */
export const javaScriptAnalysisCoverageLimits = (
  limits: Readonly<Record<string, JsonValue>> | null,
): ApplicationCoverage["limits"] => {
  const result: ApplicationCoverage["limits"] = [];
  for (const key of [
    "worker_heap_limit_bytes",
    "worker_process_memory_limit_bytes",
    "worker_timeout_ms",
    "parent_result_budget_bytes",
    "parent_available_result_budget_bytes",
    "semantic_result_budget_bytes",
    "transfer_record_bytes",
    "transfer_file_bytes",
  ]) {
    const value = limits?.[key];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
      continue;
    result.push({
      name: `javascript_analysis_${key}`,
      value,
      unit: key.endsWith("_ms") ? "milliseconds" : "bytes",
    });
  }
  return result;
};

/** Optional operational choices; omission keeps them out of Evidence parameters. */
export const javaScriptAnalysisResourceControlsSchema = z.strictObject({
  max_semantic_nodes: z
    .number()
    .int()
    .min(1)
    .max(JAVASCRIPT_SEMANTIC_ITEM_MAXIMUM)
    .optional()
    .describe(
      "Maximum retained semantic nodes across the application; defaults to 100000. Worker heap and parent result admission remain enforced.",
    ),
  max_semantic_nodes_per_file: z
    .number()
    .int()
    .min(1)
    .max(JAVASCRIPT_SEMANTIC_ITEM_MAXIMUM)
    .optional()
    .describe(
      "Maximum retained semantic nodes per source file; defaults to 20000, additionally bounded by max_semantic_nodes and memory/transfer limits.",
    ),
  max_semantic_unknowns: z
    .number()
    .int()
    .min(1)
    .max(JAVASCRIPT_SEMANTIC_ITEM_MAXIMUM)
    .optional()
    .describe(
      "Maximum retained semantic unknown records across the application; defaults to 100000. Omitted emission occurrences are counted by family and reason.",
    ),
  max_semantic_unknowns_per_file: z
    .number()
    .int()
    .min(1)
    .max(JAVASCRIPT_SEMANTIC_ITEM_MAXIMUM)
    .optional()
    .describe(
      "Maximum retained semantic unknown records per source file; defaults to 20000, additionally bounded by max_semantic_unknowns and memory/transfer limits.",
    ),
  max_heap_mb: z
    .number()
    .int()
    .min(JAVASCRIPT_WORKER_HEAP_MIB_MINIMUM)
    .max(JAVASCRIPT_WORKER_HEAP_MIB_MAXIMUM)
    .optional()
    .describe(
      "Maximum V8 old-space heap in MiB for the isolated JavaScript source analyzer; defaults to 1024. This does not change the CLI/MCP process heap. When REA runs on Bun, which ignores V8 heap flags, Windows instead limits the analyzer's committed memory to this budget plus a 512 MiB runtime reserve; other Bun hosts enforce no limit.",
    ),
  analysis_timeout_ms: z
    .number()
    .int()
    .min(1)
    .max(2_147_483_647)
    .optional()
    .describe(
      "Maximum startup, analysis and transfer time per JavaScript source, in milliseconds; defaults to 300000. On timeout, return collected partial Evidence and stop the analysis.",
    ),
});
