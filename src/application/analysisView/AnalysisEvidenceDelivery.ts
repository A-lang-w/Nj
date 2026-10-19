import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
} from "../../domain/analysisErrorCore.js";
import type { Evidence } from "../../domain/evidence.js";
import { createImmutableEvidenceBundle } from "../../domain/evidenceBundle.js";
import { err, type Result } from "../../domain/result.js";
import type { ArtifactResourceScope } from "../../artifacts/ArtifactResourceScope.js";
import type { InspectAnalysisViewInput } from "../../domain/analysisView/analysisView.js";
import { persistEvidenceBundleCommand } from "../EvidenceBundleCommands.js";
import { readImmutableEvidenceBundle } from "../EvidenceBundleFiles.js";
import { inspectAnalysisViewValidated } from "./AnalysisViewService.js";

/** Deliver complete Evidence or its linked summary with an explicit portable parent. */
export const runWithAnalysisEvidenceDelivery = async (
  operation: string,
  options: {
    readonly detail?: "complete" | "summary";
    readonly evidenceBundlePath?: string;
  },
  execute: () => Promise<Result<Evidence, AnalysisError>>,
  signal?: AbortSignal,
): Promise<Result<Evidence, AnalysisError>> => {
  if (options.detail === "summary" && options.evidenceBundlePath === undefined)
    return err(
      new AnalysisInputError(operation, undefined, [
        {
          path: ["evidence_bundle"],
          reason: "missing_argument",
          message:
            "summary detail requires --evidence-bundle so complete Evidence remains available to later CLI commands",
        },
      ]),
    );
  const original = await execute();
  if (!original.ok) return original;
  if (signal?.aborted)
    return err(
      new AnalysisCancelledError(operation, {
        cause: signal.reason,
        partialObservation: original.value,
      }),
    );
  if (options.evidenceBundlePath === undefined) return original;
  const bundle = createImmutableEvidenceBundle([original.value]);
  const delivered =
    options.detail === "summary"
      ? inspectAnalysisViewValidated(
          {
            source: {
              kind: "retained-evidence",
              evidence_id: original.value.evidence_id,
            },
            view: { kind: "summary" },
          },
          (id) => bundle.records.find((record) => record.evidence_id === id),
        )
      : original;
  if (!delivered.ok) return delivered;
  const written = await persistEvidenceBundleCommand(
    bundle,
    options.evidenceBundlePath,
    false,
    signal,
  );
  if (!written.ok)
    return err(written.error.retainPartialObservation(original.value));
  if (signal?.aborted)
    return err(
      new AnalysisCancelledError(operation, {
        cause: signal.reason,
        partialObservation: delivered.value,
        diagnostics: { evidence_bundle: { ...written.value } },
      }),
    );
  return delivered;
};

/** Resolve the caller's exact retained parent from an authenticated portable bundle. */
export const inspectAnalysisViewFromBundle = async (
  input: InspectAnalysisViewInput,
  bundlePath: string,
  resources: ArtifactResourceScope,
  signal?: AbortSignal,
): Promise<Result<Evidence, AnalysisError>> => {
  if (input.source.kind !== "retained-evidence")
    return err(
      new AnalysisInputError("inspect_analysis_view", undefined, [
        {
          path: ["source", "kind"],
          reason: "invalid_value",
          message:
            "--evidence-bundle requires a retained-evidence source with the exact parent evidence_id; inline Evidence already supplies its source",
        },
      ]),
    );
  const loaded = await readImmutableEvidenceBundle(
    bundlePath,
    signal,
    resources,
  );
  if (!loaded.ok) return loaded;
  return inspectAnalysisViewValidated(input, (id) =>
    loaded.value.records.find((record) => record.evidence_id === id),
  );
};
