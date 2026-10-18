import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";

import { OFFICIAL_TOOL_CONTRACTS } from "../contracts/officialToolContracts.js";
import { registerEvidenceTools } from "./registerEvidenceTools.js";
import {
  retainedSummaryDelivery,
  withoutDeliveryDetail,
  type EvidenceToolFamilyOptions,
} from "./retainedSummaryDelivery.js";

const SUMMARY_DELIVERY: ReadonlySet<string> = new Set([
  "procedure_pseudo_code",
]);

/** Register direct observations with shared Evidence ownership and optional pseudocode summaries. */
export const registerOfficialTools = (
  server: EvidenceMcpServer,
  options: EvidenceToolFamilyOptions,
): void => {
  const withoutDelivery = withoutDeliveryDetail(SUMMARY_DELIVERY);
  registerEvidenceTools(server, OFFICIAL_TOOL_CONTRACTS, {
    ...options,
    ...retainedSummaryDelivery(SUMMARY_DELIVERY, options),
    parametersForExecution: withoutDelivery,
    parametersForEvidence: withoutDelivery,
  });
};
