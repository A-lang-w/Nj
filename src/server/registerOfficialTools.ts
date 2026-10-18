import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";

import { OFFICIAL_TOOL_CONTRACTS } from "../contracts/officialToolContracts.js";
import { registerEvidenceTools } from "./registerEvidenceTools.js";
import type { EvidenceToolFamilyOptions } from "./retainedSummaryDelivery.js";

/** Register direct observations with shared Evidence ownership. */
export const registerOfficialTools = (
  server: EvidenceMcpServer,
  options: EvidenceToolFamilyOptions,
): void => {
  registerEvidenceTools(server, OFFICIAL_TOOL_CONTRACTS, options);
};
