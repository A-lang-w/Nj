import { z } from "zod";
import { localPathStringSchema } from "../localPath.js";
import { digestSchema } from "../digests.js";
import { jsonValueSchema } from "../jsonValue.js";

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const decimal = z.string().regex(/^(?:0|[1-9][0-9]*)$/u);

export const modelSourceSchema = z.strictObject({
  path: localPathStringSchema,
  file_size: count,
  header_sha256: digestSchema,
  header_length: count,
  sha256: digestSchema.nullable(),
  bytes_read: count,
  read_scope: z.enum(["header", "full-file"]),
});

const location = {
  source_offset: count,
  source_length: count,
  json_pointer: z.string().nullable(),
};

/** Arrays retain declared types/counts and bounded observations, never an implicit full vocabulary. */
export const modelMetadataSchema = z.strictObject({
  index: count,
  key: z.string(),
  type: z.string(),
  value: jsonValueSchema,
  element_type: z.string().nullable(),
  element_count: count.nullable(),
  preview_complete: z.boolean(),
  ...location,
});

export const modelTensorSchema = z.strictObject({
  index: count,
  name: z.string(),
  type: z.string(),
  type_id: count.nullable(),
  shape: z.array(decimal),
  data_offset: count,
  file_offset: count,
  byte_length: count.nullable(),
  parameter_count: decimal,
  byte_length_state: z.enum(["derived", "declared", "unknown"]),
  storage_validation: z.enum(["consistent", "unknown"]),
  ...location,
});

export const modelArtifactSchema = z.strictObject({
  artifact: modelSourceSchema,
  format: z.enum(["gguf", "safetensors"]),
  version: count.nullable(),
  byte_order: z.enum(["little", "big"]),
  alignment: count.nullable(),
  tensor_data_offset: count,
  metadata: z.array(modelMetadataSchema),
  tensors: z.array(modelTensorSchema),
  totals: z.strictObject({
    confidence: z.literal("derived"),
    parameter_count: decimal,
    tensor_bytes: count.nullable(),
    by_type: z.array(
      z.strictObject({
        type: z.string(),
        tensors: count,
        parameter_count: decimal,
        bytes: count.nullable(),
      }),
    ),
  }),
  coverage: z.strictObject({
    header: z.literal("complete"),
    tensor_data: z.literal("not-interpreted"),
    array_values: z.enum(["complete", "preview"]),
    tensor_ranges: z.enum(["complete", "partial"]),
    storage_sizes: z.enum(["complete", "partial"]),
  }),
  limitations: z.array(z.string()),
});

export type ModelArtifact = z.infer<typeof modelArtifactSchema>;
export type ModelTensor = z.infer<typeof modelTensorSchema>;
export type ModelMetadata = z.infer<typeof modelMetadataSchema>;
export interface ModelArtifactInput {
  readonly path: string;
  readonly hash: "header" | "full";
}
