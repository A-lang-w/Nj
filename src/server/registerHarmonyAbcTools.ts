import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";
import type { HarmonyAbcAnalysisService } from "../application/harmony/HarmonyAbcAnalysisService.js";
import { HARMONY_ABC_TOOL_CONTRACTS } from "../contracts/harmony/harmonyAbcToolContracts.js";
import { toolContract } from "../contracts/toolContracts.js";
import type { Logger } from "pino";
import type { EvidenceWriter } from "../application/investigation/InvestigationRecordPort.js";
import type { WithAdmittedAnalysis } from "./analysisAdmission.js";
import { createContractToolHandler } from "./contractToolHandler.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";

/** Bind HarmonyOS Ark bytecode handlers to their exact named schemas. */
export const registerHarmonyAbcTools = (
  server: EvidenceMcpServer,
  service: HarmonyAbcAnalysisService,
  logger: Logger,
  recordEvidence?: EvidenceWriter["recordEvidence"],
  withAdmittedAnalysis?: WithAdmittedAnalysis,
): void => {
  const handler = createContractToolHandler(
    server,
    service,
    logger,
    recordEvidence,
    withAdmittedAnalysis,
  );
  for (const contract of HARMONY_ABC_TOOL_CONTRACTS) {
    const tool = toolContract(contract.name);
    server.registerTool(
      tool.name,
      toolRegistrationOptions(tool),
      handler(tool),
    );
  }
};
