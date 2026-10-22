import { z } from "incur";

import {
  executableFormatHintSchema,
  type ExecutableFormatHint,
} from "../domain/dosCom.js";
import type {
  BinaryArchitecture,
  RawProcessorVariant,
} from "../domain/binaryTargetTypes.js";
import {
  binaryArchitectureSchema,
  rawBinaryEntryPointSchema,
  rawBinaryBaseAddressSchema,
  rawProcessorVariantSchema,
} from "../domain/rawBinary.js";
import { analysisProviderSelectorSchema } from "../contracts/providerSelection.js";
import type { AnalysisProviderSelector } from "../contracts/providerSelection.js";
import type { Logger } from "pino";

/** Parse decimal integer tokens before Number coercion can erase their syntax. */
export const cliIntegerArgument = (min: number) =>
  z
    .string()
    .regex(/^[0-9]+$/u, "Expected a decimal integer")
    .pipe(z.coerce.number<string>().safe().min(min));

export const providerSelectionOption = analysisProviderSelectorSchema
  .optional()
  .describe(
    "Bind deep analysis to a provider ID or use deterministic auto selection",
  );

/** Optional path to the local analysis snapshot loaded or updated by a command. */
export const snapshotSelectionOption = z
  .string()
  .min(1)
  .optional()
  .describe("Load and update a local analysis snapshot");

/** Explicit interpretation for headerless native executable formats. */
export const formatSelectionOption = executableFormatHintSchema
  .optional()
  .describe(
    "Explicit headerless interpretation (dos-com or raw-binary); omission preserves header-based detection",
  );

export const architectureSelectionOption = binaryArchitectureSchema
  .optional()
  .describe(
    "Caller-supplied CPU family; required with --target-format raw-binary",
  );

export const entryPointSelectionOption = rawBinaryEntryPointSchema
  .optional()
  .describe(
    "Caller-supplied code entry address (0xhex); also the load base when --base-address is omitted",
  );

export const baseAddressSelectionOption = rawBinaryBaseAddressSchema
  .optional()
  .describe(
    "Load address of raw file offset 0 (0xhex); defaults to --entry-point",
  );

export const processorVariantSelectionOption = rawProcessorVariantSchema
  .optional()
  .describe(
    "Explicit cortex-m Cortex/Thumb profile for a raw ARM image; generic ARM is unchanged when omitted",
  );

/** Shared CLI flags that bind a native target interpretation. */
export const nativeOpenOptionFields = {
  "target-format": formatSelectionOption,
  architecture: architectureSelectionOption,
  "entry-point": entryPointSelectionOption,
  "base-address": baseAddressSelectionOption,
  "processor-variant": processorVariantSelectionOption,
  provider: providerSelectionOption,
};

/** Native CLI flags consumed when opening a target for one-shot analysis. */
export interface NativeOpenCliFlags {
  readonly snapshot?: string | undefined;
  readonly provider?: AnalysisProviderSelector | undefined;
  readonly "target-format"?: ExecutableFormatHint | undefined;
  readonly architecture?: BinaryArchitecture | undefined;
  readonly "entry-point"?: string | undefined;
  readonly "base-address"?: string | undefined;
  readonly "processor-variant"?: RawProcessorVariant | undefined;
}

/** Map native CLI flags onto the shared one-shot analysis options. */
export const directAnalysisOptionsFromCli = (
  logger: Logger,
  options: NativeOpenCliFlags,
) => ({
  logger,
  snapshotPath: options.snapshot,
  ...(options["target-format"] === undefined
    ? {}
    : { formatHint: options["target-format"] }),
  ...(options.architecture === undefined
    ? {}
    : { architecture: options.architecture }),
  ...(options["entry-point"] === undefined
    ? {}
    : { entryPoint: options["entry-point"] }),
  ...(options["base-address"] === undefined
    ? {}
    : { baseAddress: options["base-address"] }),
  ...(options["processor-variant"] === undefined
    ? {}
    : { processorVariant: options["processor-variant"] }),
  ...(options.provider === undefined ? {} : { providerId: options.provider }),
});
