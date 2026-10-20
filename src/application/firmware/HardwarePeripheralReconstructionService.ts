import { z } from "zod";
import type {
  AnalysisOperationPort,
  ExecutionOptions,
} from "../AnalysisProvider.js";
import {
  attributeHardwareAccess,
  summarizeHardwarePeripheralInteractions,
  type AnalyzedInstructionReference,
  type HardwareAccessAttribution,
  type HardwarePeripheralBlockSummary,
} from "../../domain/firmware/hardwarePeripheralAttribution.js";
import {
  type HardwareArchitecture,
  hardwareArchitectureSchema,
  hardwareMemoryRegionKindSchema,
} from "../../domain/firmware/hardwareMemoryMap.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisOutputError,
} from "../../domain/analysisErrorCore.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { err, ok, type Result } from "../../domain/result.js";
import { referenceKindSchema } from "../../domain/hopperValues.js";

const procedureReferencesResultSchema = z.strictObject({
  reference_kinds_available: z.boolean(),
  references: z.array(
    z.strictObject({
      source_address: z.string(),
      target_address: z.string(),
      target_procedure: z
        .strictObject({ address: z.string(), name: z.string().optional() })
        .nullable()
        .optional(),
      kind: referenceKindSchema,
    }),
  ),
  unresolved_calls: z.array(
    z.strictObject({ address: z.string(), reason: z.string() }),
  ),
});

/** Input parameters for reconstructing a procedure's hardware peripheral interactions. */
export const reconstructProcedureHardwareInputSchema = z.strictObject({
  procedure: z
    .string()
    .min(1)
    .describe("Target procedure symbol name or canonical entrypoint address"),
  architecture: hardwareArchitectureSchema.describe(
    "Target hardware CPU architecture for memory map and register resolution",
  ),
});
export type ReconstructProcedureHardwareInput = z.infer<
  typeof reconstructProcedureHardwareInputSchema
>;

/** Output result detailing reconstructed hardware peripheral interactions for a procedure. */
export interface HardwarePeripheralReconstruction {
  readonly procedure: string;
  readonly architecture: HardwareArchitecture;
  readonly totalReferencesExamined: number;
  readonly mmioAccessCount: number;
  readonly nonMmioAccessCount: number;
  readonly peripheralBlocks: readonly HardwarePeripheralBlockSummary[];
  readonly attributions: readonly HardwareAccessAttribution[];
  readonly limitations: readonly string[];
}

export const hardwarePeripheralReconstructionSchema = z.strictObject({
  procedure: z.string(),
  architecture: hardwareArchitectureSchema,
  totalReferencesExamined: z.number().int().min(0),
  mmioAccessCount: z.number().int().min(0),
  nonMmioAccessCount: z.number().int().min(0),
  peripheralBlocks: z.array(
    z.strictObject({
      blockBase: z.string(),
      regionName: z.string(),
      regionKind: hardwareMemoryRegionKindSchema,
      totalAccesses: z.number().int().min(0),
      readCount: z.number().int().min(0),
      writeCount: z.number().int().min(0),
      uniqueAddresses: z.array(z.string()),
      observedOffsets: z.array(z.string()),
      knownRegisters: z.array(z.string()),
    }),
  ),
  attributions: z.array(
    z.strictObject({
      targetAddress: z.string(),
      addressValue: z.bigint(),
      architecture: hardwareArchitectureSchema,
      regionKind: hardwareMemoryRegionKindSchema,
      regionName: z.string(),
      isMmio: z.boolean(),
      accessKind: z.enum(["read", "write", "read_write", "unknown"]),
      peripheralBlockBase: z.string(),
      peripheralBlockOffset: z.string(),
      registerName: z.string().nullable().optional(),
      registerMnemonic: z.string().nullable().optional(),
      sourceAddress: z.string().nullable().optional(),
      operandIndex: z.number().nullable().optional(),
      provenance: z.string().nullable().optional(),
    }),
  ),
  limitations: z.array(z.string()),
});

/**
 * Reconstruct hardware peripheral interactions from a set of analyzed instruction references.
 * Pure deterministic domain workflow for offline and provider-decoupled analysis.
 */
export const reconstructHardwareFromReferences = (
  references: readonly AnalyzedInstructionReference[],
  architecture: HardwareArchitecture,
  procedure = "detached",
): HardwarePeripheralReconstruction => {
  const attributions: HardwareAccessAttribution[] = [];
  const limitations: string[] = [];

  for (const ref of references) {
    const attributed = attributeHardwareAccess(ref, architecture);
    if (attributed.ok) {
      attributions.push(attributed.value);
    } else {
      limitations.push(
        `Failed to attribute reference to ${ref.target_address}: ${attributed.error}`,
      );
    }
  }

  const summary = summarizeHardwarePeripheralInteractions(
    attributions,
    architecture,
  );

  return {
    procedure,
    architecture,
    totalReferencesExamined: summary.totalReferencesExamined,
    mmioAccessCount: summary.mmioAccessCount,
    nonMmioAccessCount: summary.nonMmioAccessCount,
    peripheralBlocks: summary.peripheralBlocks,
    attributions,
    limitations,
  };
};

/**
 * High-level application workflow: Reconstruct hardware peripheral interactions for a given procedure.
 * Queries provider procedure references, classifies physical memory regions, resolves standard architectural
 * registers, and aggregates interactions into cohesive 4 KiB hardware peripheral blocks.
 */
export const reconstructProcedureHardwareInteractions = async (
  analysis: AnalysisOperationPort,
  parameters: unknown,
  options?: ExecutionOptions,
): Promise<Result<HardwarePeripheralReconstruction, AnalysisError>> => {
  if (options?.signal?.aborted) {
    return err(
      new AnalysisCancelledError("reconstruct_procedure_hardware_interactions"),
    );
  }

  const parsed = reconstructProcedureHardwareInputSchema.safeParse(parameters);
  if (!parsed.success) {
    return err(
      new AnalysisInputError("reconstruct_procedure_hardware_interactions", {
        cause: parsed.error,
      }),
    );
  }

  const { procedure, architecture } = parsed.data;

  const execution = await analysis.execute(
    "procedure_references",
    { procedure, direction: "outgoing" },
    options,
  );

  if (!execution.ok) {
    return execution;
  }

  const parsedReferences = procedureReferencesResultSchema.safeParse(
    execution.value.result,
  );

  if (!parsedReferences.success) {
    return err(
      new AnalysisOutputError(
        "procedure_references",
        "Procedure references output did not match expected reference edge schema",
      ),
    );
  }

  const candidateReferences = parsedReferences.data.references;
  const analyzedReferences: AnalyzedInstructionReference[] = [];

  for (const edge of candidateReferences) {
    const kind = edge.kind;
    const isCallOrJump = kind.available && (kind.call || kind.jump);
    // Ignore direct calls and jumps to other code procedures when analyzing data/MMIO accesses
    if (isCallOrJump && !kind.data) {
      continue;
    }

    analyzedReferences.push({
      target_address: edge.target_address,
      source_address: edge.source_address,
      read: kind.available ? kind.read : null,
      write: kind.available ? kind.write : null,
      data: kind.available ? kind.data : null,
      call: kind.available ? kind.call : false,
      jump: kind.available ? kind.jump : false,
      ...(kind.available && typeof kind.operand_index === "number"
        ? { operand_index: kind.operand_index }
        : {}),
      provenance: kind.available ? kind.provenance : null,
    });
  }

  const result = reconstructHardwareFromReferences(
    analyzedReferences,
    architecture,
    procedure,
  );

  return ok(result);
};
