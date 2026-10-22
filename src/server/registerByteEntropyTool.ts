import type { ByteEntropyService } from "../application/binaryDiagnostics/ByteEntropyService.js";
import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";

import {
  requireAnalysisViewRetention,
  summarizeRetainedAnalysis,
} from "../application/analysisView/AnalysisViewService.js";
import type { EvidenceLookup } from "../application/EvidenceInputResolver.js";
import type { EvidenceWriter } from "../application/investigation/InvestigationRecordPort.js";
import { toolContract } from "../contracts/toolContracts.js";
import type { Logger } from "pino";
import { logToolExecution } from "./toolLogging.js";
import { applicationToolRegistrationOptions } from "./toolRegistrationOptions.js";
import { analysisInputErrorFromIssues } from "../domain/inputIssueProjection.js";
import { err } from "../domain/result.js";
import type { WithAdmittedAnalysis } from "./analysisAdmission.js";
import { runAdmittedToolOperation } from "./admittedToolOperation.js";

/** Reject an unretained byte-entropy summary before reading the selected file. */
export const registerByteEntropyTool = (
  server: EvidenceMcpServer,
  entropyService: ByteEntropyService,
  logger: Logger,
  recordEvidence: EvidenceWriter["recordEvidence"] | undefined,
  evidenceById: EvidenceLookup | undefined,
  withAdmittedAnalysis: WithAdmittedAnalysis | undefined,
): void => {
  const contract = toolContract("inspect_byte_entropy");
  const retention = { recordEvidence, evidenceById };
  server.registerTool(
    contract.name,
    applicationToolRegistrationOptions(contract),
    async (rawInput, context) => {
      const parsed = contract.inputSchema.safeParse(rawInput);
      if (!parsed.success)
        return server.delivery.toCallToolResult(
          err(
            analysisInputErrorFromIssues(
              contract.name,
              parsed.error.issues,
              rawInput,
              { cause: parsed.error },
            ),
          ),
          contract,
        );
      const { detail, ...request } = parsed.data;
      return runAdmittedToolOperation(
        server,
        withAdmittedAnalysis,
        contract.name,
        context.mcpReq.signal,
        async () => {
          const result = await logToolExecution(
            logger,
            contract.name,
            async () => {
              if (detail === "summary") {
                const ready = requireAnalysisViewRetention(
                  contract.name,
                  retention,
                );
                if (!ready.ok) return ready;
              }
              const inspected = await entropyService.inspect(request, {
                signal: context.mcpReq.signal,
              });
              return detail === "summary" && inspected.ok
                ? summarizeRetainedAnalysis(inspected.value, retention)
                : inspected;
            },
          );
          if (!result.ok)
            return server.delivery.toCallToolResult(result, contract);
          const recorded = recordEvidence?.(result.value);
          return server.delivery.toEvidenceToolResult(
            result.value,
            contract,
            recorded,
          );
        },
      );
    },
  );
};
