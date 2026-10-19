import { z } from "zod";
import { webPageInspectionSchema } from "../domain/browserObservationSchemas.js";
import { digestSchema } from "../domain/digests.js";
import { JAVASCRIPT_ANALYSIS_RESOURCE_DEFAULTS } from "../domain/javascript/javascriptAnalysisResourceControls.js";
import { JAVASCRIPT_ANALYSIS_WORKER_DEFAULTS } from "../javascript/analysis/JavaScriptAnalysisWorkerProtocol.js";

/** Per-script bounds shared with the isolated JavaScript analysis boundary. */
export const WEB_BUNDLE_ANALYSIS_WORKER_LIMITS = {
  heapMb: JAVASCRIPT_ANALYSIS_RESOURCE_DEFAULTS.heapMb,
  scriptTimeoutMs: JAVASCRIPT_ANALYSIS_RESOURCE_DEFAULTS.timeoutMs,
  /** Worker initialization before the parent admits any script. */
  startupTimeoutMs: JAVASCRIPT_ANALYSIS_RESOURCE_DEFAULTS.timeoutMs,
  resultBytes: JAVASCRIPT_ANALYSIS_WORKER_DEFAULTS.checkpointBytes,
  frameBytes: 4 * 1024,
} as const;

/** One captured script; the worker requires included source. */
export const webBundleWorkerScriptSchema =
  webPageInspectionSchema.shape.scripts.shape.items.element;

const index = z.number().int().min(0);

/** The parent admits exactly one script under an already-running deadline. */
export const webBundleWorkerRequestSchema = z.strictObject({
  kind: z.literal("analyze"),
  index,
  script_bytes: z.number().int().min(0),
});

/** Control frames carry indexes and digests only; facts travel in private files. */
export const webBundleWorkerFrameSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("ready") }),
  z.strictObject({ kind: z.literal("start"), index }),
  z.strictObject({
    kind: z.literal("done"),
    index,
    bytes: z.number().int().min(0),
    sha256: digestSchema,
  }),
  z.strictObject({
    kind: z.literal("oversized"),
    index,
    bytes: z.number().int().min(0),
  }),
]);
export type WebBundleWorkerFrame = z.output<typeof webBundleWorkerFrameSchema>;

/** Private files exchanged for one script index inside the owned root. */
export const webBundleWorkerFileNames = (scriptIndex: number) => ({
  script: `${String(scriptIndex)}.script.json`,
  facts: `${String(scriptIndex)}.facts.json`,
});
