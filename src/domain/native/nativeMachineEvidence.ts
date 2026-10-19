import { z } from "zod";

import {
  functionDossierSchema,
  procedureIdentitySchema,
} from "../hopperValues.js";
import { nativeInstructionSchema } from "./nativeInstruction.js";

/** Bounded whole-program export request. Providers may support only a subset. */
export const nativeMachineEvidenceInputSchema = z.strictObject({
  max_functions: z.number().int().positive().max(100_000).default(10_000),
  max_instructions: z
    .number()
    .int()
    .positive()
    .max(10_000_000)
    .default(2_000_000),
  max_body_bytes: z
    .number()
    .int()
    .positive()
    .max(1_073_741_824)
    .default(268_435_456),
  max_decompile_instructions: z
    .number()
    .int()
    .positive()
    .max(1_000_000)
    .default(1_000),
  output_path: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Explicit provider-host path for a retained JSON export. The provider refuses to replace an existing file.",
    ),
});

const delaySlot = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("none") }),
  z.strictObject({
    state: z.literal("owner"),
    slots: z.array(z.string()).min(1),
    provenance: z.literal("ghidra-listing-delay-slot-depth"),
  }),
  z.strictObject({
    state: z.literal("slot"),
    owner: z.string(),
    ordinal: z.number().int().positive(),
    provenance: z.literal("ghidra-listing-delay-slot-depth"),
  }),
]);

const exportedInstruction = nativeInstructionSchema
  .pick({
    address: true,
    bytes: true,
    length: true,
    mnemonic: true,
    raw_disassembly: true,
    operands: true,
    flow: true,
    references: true,
    pcode: true,
  })
  .safeExtend({ delay_slot: delaySlot });

const bodyBytes = z.strictObject({
  start: z.string(),
  end: z.string().describe("Inclusive end address."),
  bytes: z.string().regex(/^(?:[0-9a-f]{2})*$/u),
});

const exportedFunction = z.strictObject({
  procedure: procedureIdentitySchema,
  body_bytes: z.array(bodyBytes),
  instructions: z.array(exportedInstruction),
  basic_blocks: functionDossierSchema.shape.basic_blocks,
  incoming_references: functionDossierSchema.shape.incoming_references,
  outgoing_references: functionDossierSchema.shape.outgoing_references,
  decompiler: z.discriminatedUnion("status", [
    z.strictObject({
      status: z.literal("available"),
      pseudocode: z.string(),
      warnings: z.array(z.string()),
      provenance: z.literal("ghidra-decompiler"),
    }),
    z.strictObject({
      status: z.literal("unavailable"),
      reason: z.string().min(1),
      warnings: z.array(z.string()),
    }),
    z.strictObject({
      status: z.literal("failed"),
      code: z.string().min(1),
      reason: z.string().min(1),
      warnings: z.array(z.string()),
    }),
  ]),
  direct_calls: z.array(
    z.strictObject({ source: z.string(), target: z.string() }),
  ),
  tail_calls: z.array(
    z.strictObject({ source: z.string(), target: z.string() }),
  ),
  unresolved_computed_transfers: z.array(
    z.strictObject({
      source: z.string(),
      kind: z.enum(["call", "jump"]),
    }),
  ),
});

/** Provider-neutral machine evidence normalized from one analyzed program. */
export const nativeMachineEvidenceSchema = z.strictObject({
  schema_version: z.literal("1"),
  target: z.strictObject({
    sha256: z.string().regex(/^[0-9a-f]{64}$/u),
    language_id: z.string().min(1),
    compiler_spec_id: z.string().min(1),
    image_base: z.string().min(1),
  }),
  producer: z.strictObject({
    provider_id: z.literal("ghidra"),
    provider_version: z.string().min(1),
    analysis_profile_digest: z.string().regex(/^[0-9a-f]{64}$/u),
  }),
  coverage: z.strictObject({
    available_functions: z.number().int().nonnegative(),
    exported_functions: z.number().int().nonnegative(),
    omitted_functions: z.number().int().nonnegative(),
    exported_instructions: z.number().int().nonnegative(),
    exported_body_bytes: z.number().int().nonnegative(),
    failed_functions: z.number().int().nonnegative(),
    truncated: z.boolean(),
  }),
  functions: z.array(exportedFunction),
  limitations: z.array(z.string()),
});

/** Small authenticated receipt returned when the complete export is retained on disk. */
export const retainedNativeMachineEvidenceSchema = z.strictObject({
  retained_export: z.literal(true),
  schema_version: z.literal("1"),
  output_path: z.string().min(1),
  bytes: z.number().int().positive(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  target: nativeMachineEvidenceSchema.shape.target,
  producer: nativeMachineEvidenceSchema.shape.producer,
  coverage: nativeMachineEvidenceSchema.shape.coverage,
  limitations: nativeMachineEvidenceSchema.shape.limitations,
});

export const nativeMachineEvidenceResultSchema = z.union([
  nativeMachineEvidenceSchema,
  retainedNativeMachineEvidenceSchema,
]);

export type NativeMachineEvidence = z.infer<typeof nativeMachineEvidenceSchema>;
