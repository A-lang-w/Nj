import {
  binaryLayoutPayloadSchema,
  binaryLayoutSchema,
  type BinaryLayout,
  type InspectBinaryLayoutInput,
} from "../../domain/native/binaryLayout.js";
import { AnalysisOutputError } from "../../domain/analysisErrorCore.js";
import { PwntoolsDecoder, type PwntoolsLauncher } from "./PwntoolsDecoder.js";
import { PWNTOOLS_PROVIDER_IDENTITY } from "./PwntoolsRelease.js";
import { PrivateRuntimeRoot } from "../../process/PrivateRuntimeRoot.js";
import type { BinaryLayoutPort } from "../../application/binaryDiagnostics/BinaryLayoutPort.js";
import type { z } from "zod";

/** ELF-specific projection around the shared owned pwntools decoder boundary. */
export class PwntoolsLayoutProvider
  extends PwntoolsDecoder<
    InspectBinaryLayoutInput,
    z.output<typeof binaryLayoutPayloadSchema>,
    BinaryLayout
  >
  implements BinaryLayoutPort
{
  constructor(
    environment: Readonly<NodeJS.ProcessEnv>,
    launcher?: PwntoolsLauncher,
    createRuntime: () => Promise<
      Pick<PrivateRuntimeRoot, "path" | "close">
    > = () => PrivateRuntimeRoot.create({ prefix: "rea-elf-layout-" }),
  ) {
    super(
      {
        identity: PWNTOOLS_PROVIDER_IDENTITY,
        operation: "inspect_binary_layout",
        bridge: new URL("../../../bridge/pwntools/layout.py", import.meta.url),
        payloadSchema: binaryLayoutPayloadSchema,
        unsupportedTargetRemediationAction:
          "For file or section headers, use inspect_with_objdump with operation file_headers or section_headers (CLI: rea inspect-with-objdump <path> file_headers or section_headers). Supply GNU objdump with support for the selected target via REA_OBJDUMP_COMMAND or PATH. For ELF32/ELF64 note records, use inspect_elf_notes (CLI: rea inspect-elf-notes <path>). These operations return narrower facts, not the complete normalized binary layout report; inspect_binary_layout remains limited to ELF64 x86-64 little-endian EXEC/DYN/REL.",
        project: ({ input, payload, snapshot, diagnostics }) => {
          const value = binaryLayoutSchema.safeParse({
            ...payload,
            artifact: {
              path: input.path,
              sha256: snapshot.sha256,
              bytes: snapshot.bytes.length,
            },
            diagnostics,
          });
          if (!value.success)
            throw new AnalysisOutputError(
              "inspect_binary_layout",
              `ELF reply contains invalid source ranges or value meanings: ${value.error.issues[0]?.message ?? "schema mismatch"}`,
              { capturedOutput: diagnostics },
            );
          for (const table of value.data.packed_relative_relocations) {
            const start = Number(BigInt(table.location.offset));
            const length = Number(BigInt(table.location.bytes));
            if (
              !Buffer.from(table.encoded_bytes_base64, "base64").equals(
                snapshot.bytes.subarray(start, start + length),
              )
            )
              throw new AnalysisOutputError(
                "inspect_binary_layout",
                "Reported packed relocation bytes differ from the selected snapshot at their original file range.",
                { capturedOutput: diagnostics },
              );
          }
          return value.data;
        },
      },
      environment,
      launcher,
      createRuntime,
    );
  }
}
