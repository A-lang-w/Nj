import { resolveSourceToBundleReference } from "../../application/javascript/SourceToBundleReference.js";
import {
  requireAnalysisViewRetention,
  inspectAnalysisViewValidated,
} from "../../application/analysisView/AnalysisViewService.js";
import type { EvidenceMcpServer } from "../EvidenceMcpServer.js";
import { runAdmittedToolOperation } from "../admittedToolOperation.js";
import { resolveApplicationEvidenceRequest } from "../../application/EvidenceInputResolver.js";
import { recordSessionEvidenceSources } from "../sessionEvidence.js";

import { compareSourceToBundleEvidenceValidated } from "../../application/javascript/JavaScriptApplicationWorkflowService.js";
import { applicationToolContract } from "../../contracts/applicationToolContracts.js";
import { sourceToBundleComparisonResultSchema } from "../../domain/javascript/sourceToBundleComparisonSchemas.js";
import { logToolExecution } from "../toolLogging.js";
import { toolRegistrationOptions } from "../toolRegistrationOptions.js";
import { recordApplicationResult } from "./helpers.js";
import type { ApplicationToolRegistration } from "./types.js";

const contract = applicationToolContract("compare_source_to_bundle");

/** Register conservative historical-source to bundle comparison. */
export const registerCompareSourceToBundleTool = (
  server: EvidenceMcpServer,
  options: ApplicationToolRegistration,
): void => {
  server.registerTool(
    contract.name,
    toolRegistrationOptions(contract),
    async (input, context) =>
      runAdmittedToolOperation(
        server,
        options.withAdmittedAnalysis,
        contract.name,
        context.mcpReq.signal,
        async () => {
          if (input.view !== undefined) {
            const retention = requireAnalysisViewRetention(
              contract.name,
              options,
            );
            if (!retention.ok)
              return server.delivery.toCallToolResult(retention, contract);
          }
          const resolved = resolveApplicationEvidenceRequest(
            input,
            options.evidenceById,
          );
          if (!resolved.ok)
            return server.delivery.toCallToolResult(resolved, contract);
          const reference = await resolveSourceToBundleReference(
            resolved.value.reference,
            context.mcpReq.signal,
            options.artifactResources,
          );
          if (!reference.ok)
            return server.delivery.toCallToolResult(reference, contract);
          const parsed = {
            reference: reference.value,
            application: resolved.value.application,
          };
          const result = await logToolExecution(
            options.logger,
            contract.name,
            () =>
              Promise.resolve(compareSourceToBundleEvidenceValidated(parsed)),
          );
          if (!result.ok)
            return server.delivery.toCallToolResult(result, contract);
          const recorded = recordSessionEvidenceSources(
            options.recordEvidence,
            [parsed.application],
          );
          if (!recorded.ok)
            return server.delivery.toCallToolResult(recorded, contract);
          const comparison = sourceToBundleComparisonResultSchema.parse(
            result.value.normalized_result,
          );
          const parent = result.value;
          const saved = recordApplicationResult(
            options,
            parent,
            comparison.summary.unknown > 0
              ? "source-to-bundle-comparison"
              : undefined,
          );
          if (saved !== undefined && !saved.ok)
            return server.delivery.toCallToolResult(saved, contract);
          if (input.view === undefined)
            return server.delivery.toEvidenceToolResult(
              parent,
              contract,
              saved,
            );
          const selected = inspectAnalysisViewValidated(
            {
              source: {
                kind: "retained-evidence",
                evidence_id: parent.evidence_id,
              },
              view: input.view,
            },
            options.evidenceById,
          );
          if (!selected.ok)
            return server.delivery.toCallToolResult(selected, contract);
          return server.delivery.toEvidenceToolResult(
            selected.value,
            contract,
            options.recordEvidence?.(selected.value),
          );
        },
      ),
  );
};
