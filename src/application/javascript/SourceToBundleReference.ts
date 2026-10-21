import { setImmediate } from "node:timers/promises";
import type { z } from "zod";
import type { compareSourceToBundleCliInputSchema } from "../../contracts/javascript/applicationWorkflowInputContracts.js";
import {
  historicalSourceGraphSchema,
  type HistoricalSourceGraph,
} from "../../domain/referenceSourceGraph.js";
import type { ArtifactResourceScope } from "../../artifacts/ArtifactResourceScope.js";
import { AnalysisCancelledError } from "../../domain/analysisErrorCore.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { analysisInputErrorFromIssues } from "../../domain/inputIssueProjection.js";
import { err, ok, type Result } from "../../domain/result.js";
import { readJsonFile } from "../JsonFiles.js";

/** Resolve one caller-selected historical graph using the shared bounded regular-file reader. No file cache. */
export const resolveSourceToBundleReference = async (
  reference: z.output<typeof compareSourceToBundleCliInputSchema>["reference"],
  signal?: AbortSignal,
  resources?: ArtifactResourceScope,
): Promise<Result<HistoricalSourceGraph, AnalysisError>> => {
  const cancelled = () => signal?.aborted === true;
  if (cancelled())
    return err(
      new AnalysisCancelledError("compare_source_to_bundle", {
        cause: signal?.reason,
      }),
    );
  if (!("kind" in reference)) return ok(reference);
  const read = await readJsonFile(reference.path, signal, resources);
  if (!read.ok) return read;
  await setImmediate();
  if (cancelled())
    return err(
      new AnalysisCancelledError("compare_source_to_bundle", {
        cause: signal?.reason,
      }),
    );
  const parsed = historicalSourceGraphSchema.safeParse(read.value);
  if (!parsed.success)
    return err(
      analysisInputErrorFromIssues(
        "compare_source_to_bundle",
        parsed.error.issues.map((issue) => ({
          ...issue,
          path: ["reference", ...issue.path],
        })),
        { reference: read.value },
        { cause: parsed.error },
      ),
    );
  return ok(parsed.data);
};
