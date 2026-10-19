import { analysisErrorProjectionSchema } from "../../dist/contracts/errorSchemas.js";
import { toolContract } from "../../dist/contracts/toolContracts.js";
import {
  expandProviderCapabilities,
  expandToolAvailability,
  providerCapabilitySet,
} from "../../dist/contracts/toolOutputSchemaPrimitives.js";
import { compareUnicodeCodePoints } from "../../dist/domain/unicodeCodePointOrder.js";

/** Read the textual JSON projection from one MCP tool call. */
export const mcpTextValue = (result) => {
  const text = result.content?.find((item) => item.type === "text")?.text;
  if (typeof text !== "string") throw new Error("Tool result omitted text");
  return text;
};

const jsonValue = (result) => JSON.parse(mcpTextValue(result));

/** Sort canonical contract names using REA's code-point ordering. */
export const sortVerifierNames = (names) =>
  [...names].sort(compareUnicodeCodePoints);

/** Read the complete canonical diagnostic from an MCP tool failure. */
export const requireMcpToolError = (result) => {
  if (result.isError !== true) throw new Error("Expected an MCP tool failure");
  return analysisErrorProjectionSchema.parse(jsonValue(result).error);
};

const requireOutput = (result, operation, contract) => {
  if (result.isError === true)
    throw new Error(`${operation} failed: ${mcpTextValue(result)}`);
  if (contract.name !== operation)
    throw new Error(`${operation} received the ${contract.name} contract`);
  return contract.outputSchema.parse(jsonValue(result));
};

const operationResultKey = (output, operation) => {
  if (output.delivery === "retained-inventory")
    throw new Error(
      `${operation} requires the asynchronous inventory result reader`,
    );
  const evidence = Object.hasOwn(output, "normalized_result");
  const lifecycle = Object.hasOwn(output, "result");
  if (evidence === lifecycle)
    throw new Error(`${operation} has an unsupported MCP output`);
  return evidence ? "normalized_result" : "result";
};

/** Read every retained row with validated identity, coverage and forward progress. */
export const requireMcpInventoryResult = async (
  result,
  operation,
  callTool,
) => {
  const output = requireOutput(result, operation, toolContract(operation));
  if (output.delivery !== "retained-inventory") {
    const rows = output.normalized_result;
    if (!Array.isArray(rows))
      throw new Error(`${operation} is not an inventory`);
    return rows;
  }

  const { source, view } = output.continuation.arguments;
  if (
    source.evidence_id !== output.evidence_id ||
    output.evidence_reference.evidence_id !== output.evidence_id ||
    view.offset !== 0
  )
    throw new Error(
      `${operation} supplied an inconsistent retained continuation`,
    );

  const rows = [];
  let offset = 0;
  while (true) {
    const response = await callTool({
      name: output.continuation.name,
      arguments: { source, view: { ...view, offset } },
    });
    const page = requireMcpEvidenceResult(response, "inspect_analysis_view");
    const coverage = page.coverage;
    if (
      page.kind !== "page" ||
      page.parent_evidence_id !== output.evidence_id ||
      page.parent_operation !== operation ||
      page.view.collection !== view.collection ||
      page.view.offset !== offset ||
      coverage.total !== output.total_items ||
      coverage.examined !== page.items.length
    )
      throw new Error(
        `${operation} returned inconsistent retained page coverage`,
      );

    rows.push(...page.items);
    if (coverage.exhausted) {
      if (coverage.next_offset !== null || rows.length !== output.total_items)
        throw new Error(
          `${operation} ended before its complete inventory was read`,
        );
      return rows;
    }
    if (page.items.length === 0 || coverage.next_offset !== rows.length)
      throw new Error(`${operation} returned a non-advancing inventory page`);
    offset = coverage.next_offset;
  }
};

/** Expand compact session metadata once at the verifier boundary. */
export const expandMcpSessionStatus = (status) => ({
  ...status,
  capabilities: expandProviderCapabilities(status.capabilities),
  analysis_provider_candidates: expandProviderCandidates(
    status.analysis_provider_candidates,
  ),
  tool_availability: expandToolAvailability(status.tool_availability),
});

/** Expand provider capability groups while retaining candidate identity/state. */
export const expandProviderCandidates = (candidates) =>
  candidates.map((candidate) => ({
    ...candidate,
    capabilities: expandProviderCapabilities(
      providerCapabilitySet.array().parse(candidate.capabilities),
    ),
  }));

/** Expand CLI provider capability groups at the same owning boundary. */
export const expandProviderOutput = (providers) => ({
  ...providers,
  capabilities: expandProviderCapabilities(
    providerCapabilitySet.array().parse(providers.capabilities),
  ),
  analysis_provider_candidates: expandProviderCandidates(
    providers.analysis_provider_candidates,
  ),
});

/** Expand the CLI capabilities command's compact provider descriptor groups. */
export const expandCapabilitiesOutput = (capabilities) => ({
  ...capabilities,
  capabilities: expandProviderCapabilities(
    providerCapabilitySet.array().parse(capabilities.capabilities),
  ),
});

/** Validate an Evidence-producing tool output and return its normalized result. */
export const requireMcpEvidenceResult = (result, operation) => {
  const contract = toolContract(operation);
  const output = requireOutput(result, operation, contract);
  if (operationResultKey(output, operation) !== "normalized_result")
    throw new Error(`${operation} requires the lifecycle result extractor`);
  return output.normalized_result;
};

/** Validate a lifecycle tool output and return its operation result. */
export const requireMcpLifecycleResult = (result, operation) => {
  const contract = toolContract(operation);
  const output = requireOutput(result, operation, contract);
  if (operationResultKey(output, operation) !== "result")
    throw new Error(`${operation} requires the Evidence result extractor`);
  const projected = output.result;
  return operation === "binary_session"
    ? expandMcpSessionStatus(projected)
    : projected;
};

/** Project a mixed verifier call using its exact named canonical output schema. */
export const requireMcpOperationResult = (
  result,
  operation,
  contract = toolContract(operation),
) => {
  const output = requireOutput(result, operation, contract);
  const key = operationResultKey(output, operation);
  const projected = output[key];
  return operation === "binary_session"
    ? expandMcpSessionStatus(projected)
    : projected;
};

/** Verify provider identity directly from the tool result. */
export const requireEvidenceProvider = (result, operation, providerId) => {
  const evidence = jsonValue(result);
  if (
    evidence?.provider?.id !== providerId ||
    evidence?.analysis_profile?.provider?.id !== providerId ||
    typeof evidence.analysis_profile.provider.version !== "string"
  ) {
    throw new Error(`${operation} omitted its concrete provider provenance`);
  }
};

/** Verify composed workflow and upstream provider provenance inline. */
export const requireWorkflowEvidenceProvider = (
  result,
  operation,
  expected,
) => {
  const evidence = jsonValue(result);
  const profile = evidence?.analysis_profile;
  const upstream = profile?.parameters?.upstream_analysis_profile;
  if (
    evidence?.provider?.id !== expected.workflowProviderId ||
    profile?.provider?.id !== expected.workflowProviderId ||
    upstream?.provider?.id !== expected.upstreamProviderId ||
    typeof upstream.provider.version !== "string"
  ) {
    throw new Error(
      `${operation} omitted its composed workflow or upstream provenance`,
    );
  }
};
