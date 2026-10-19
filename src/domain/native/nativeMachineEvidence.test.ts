import { describe, expect, it } from "vitest";

import {
  nativeDelaySlotSchema,
  nativeMachineEvidenceInputSchema,
  nativeMachineEvidenceResultSchema,
  recognizedComputedTransferSchema,
} from "./nativeMachineEvidence.js";

describe("native machine evidence", () => {
  it("preserves an unresolved physical delay slot without assigning a later instruction", () => {
    const owner = nativeDelaySlotSchema.parse({
      state: "owner",
      slots: [],
      unresolved_slots: ["0x8c010008"],
      provenance: "ghidra-listing-delay-slot-depth",
    });
    expect(owner).toEqual({
      state: "owner",
      slots: [],
      unresolved_slots: ["0x8c010008"],
      provenance: "ghidra-listing-delay-slot-depth",
    });
  });

  it("accepts an evidence-bound SH-4 literal-loaded transfer", () => {
    expect(
      recognizedComputedTransferSchema.parse({
        source: "0x8c010012",
        target: "0x8c010000",
        kind: "call",
        mechanism: "pc-relative-literal-load",
        architecture: "sh4",
        register: "r2",
        load_instruction: "0x8c010010",
        literal_address: "0x8c010018",
        literal_bytes: "0000018c",
        byte_order: "little",
        target_memory: { initialized: true, executable: true },
        provenance: [
          "ghidra-listing-register-def-use",
          "ghidra-reference-manager",
          "ghidra-initialized-memory",
        ],
      }),
    ).toMatchObject({ target: "0x8c010000", register: "r2" });
  });

  it("applies bounded defaults without selecting retained output", () => {
    expect(nativeMachineEvidenceInputSchema.parse({})).toEqual({
      max_functions: 10_000,
      max_instructions: 2_000_000,
      max_body_bytes: 268_435_456,
      max_decompile_instructions: 1_000,
    });
  });

  it("accepts an authenticated retained-export receipt", () => {
    const parsed = nativeMachineEvidenceResultSchema.parse({
      retained_export: true,
      schema_version: "1",
      output_path: "/tmp/evidence.json",
      bytes: 686_986_777,
      sha256: "b".repeat(64),
      target: {
        sha256: "c".repeat(64),
        language_id: "SuperH4:LE:32:default",
        compiler_spec_id: "default",
        image_base: "0x0",
      },
      producer: {
        provider_id: "ghidra",
        provider_version: "12.1.4",
        analysis_profile_digest: "d".repeat(64),
      },
      coverage: {
        available_functions: 4_172,
        exported_functions: 4_172,
        omitted_functions: 0,
        exported_instructions: 453_376,
        exported_body_bytes: 906_752,
        failed_functions: 65,
        truncated: false,
      },
      limitations: ["Provider analysis is not original source."],
    });
    expect("retained_export" in parsed && parsed.retained_export).toBe(true);
  });

  it("rejects a retained receipt without a binding digest", () => {
    const value = {
      retained_export: true,
      schema_version: "1",
      output_path: "/tmp/evidence.json",
      bytes: 1,
      sha256: "b".repeat(64),
      target: {
        sha256: "c".repeat(64),
        language_id: "SuperH4:LE:32:default",
        compiler_spec_id: "default",
        image_base: "0x0",
      },
      producer: {
        provider_id: "ghidra",
        provider_version: "12.1.4",
      },
      coverage: {
        available_functions: 1,
        exported_functions: 1,
        omitted_functions: 0,
        exported_instructions: 1,
        exported_body_bytes: 2,
        failed_functions: 0,
        truncated: false,
      },
      limitations: [],
    };
    expect(nativeMachineEvidenceResultSchema.safeParse(value).success).toBe(
      false,
    );
  });
});
