import { z } from "zod";
import { logger } from "../lib/logger.js";

// --- Zod Schemas for JSON columns ---

/** Validates thread_metadata JSON column for thread-level attributes like pin state, labels, and summary. */
export const threadMetadataSchema = z
  .object({
    pinned: z.boolean().optional(),
    labels: z.array(z.string()).optional(),
    summary: z.string().optional(),
  })
  .passthrough();

/** Validates memory_tags JSON column storing string tag arrays for memory entries. */
export const memoryTagsSchema = z.array(z.string());

/** Validates embedding vector columns stored as numeric arrays for semantic search. */
export const embeddingSchema = z.array(z.number());

/** Validates memory_metadata JSON column for provenance, confidence scores, and extraction timestamps. */
export const memoryMetadataSchema = z
  .object({
    source: z.string().optional(),
    confidence: z.number().optional(),
    extractedAt: z.string().optional(),
  })
  .passthrough();

/** Validates skill trigger pattern arrays used to match user input against skill activation rules. */
export const skillTriggerPatternsSchema = z.array(z.string());

/** Validates skill_metadata JSON column for skill version, category classification, and usage examples. */
export const skillMetadataSchema = z
  .object({
    version: z.string().optional(),
    category: z.string().optional(),
    examples: z.array(z.string()).optional(),
  })
  .passthrough();

// --- Safe parse helpers ---

export function safeParseJson<T>(
  raw: unknown,
  schema: z.ZodType<T>,
  context: { table: string; column: string; rowId?: unknown },
  fallback: T,
): T {
  if (raw === null || raw === undefined) {
    return fallback;
  }

  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      logger.warn("JSON parse failed for blob column", {
        table: context.table,
        column: context.column,
        rowId: context.rowId,
        error: err instanceof Error ? err.message : String(err),
      });
      return fallback;
    }
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    logger.warn("Schema validation failed for blob column", {
      table: context.table,
      column: context.column,
      rowId: context.rowId,
      issues: result.error.issues.slice(0, 5).map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    });
    return fallback;
  }

  return result.data;
}

// --- Row mappers for JSON columns ---

/** Raw memory row shape expected by parseMemoryRow; mirrors the memories table select type. */
export interface MemoryRowInput {
  id: number;
  tagsJson: unknown;
  embeddingJson: unknown;
  metadataJson: unknown;
  [key: string]: unknown;
}

/** Parsed memory row with validated JSON fields replacing their raw counterparts. */
export interface ParsedMemoryRow extends Omit<
  MemoryRowInput,
  "tagsJson" | "embeddingJson" | "metadataJson"
> {
  tagsJson: string[];
  embeddingJson: number[] | null;
  metadataJson: Record<string, unknown>;
}

/**
 * Maps a raw memory row to its parsed shape, validating tags, embedding, and metadata JSON columns.
 *
 * @param row - The raw database row from the memories table.
 * @returns A copy of the row with JSON columns replaced by their validated, typed values.
 */
export function parseMemoryRow<T extends MemoryRowInput>(
  row: T,
): ParsedMemoryRow & Omit<T, keyof MemoryRowInput> {
  return {
    ...row,
    tagsJson: safeParseJson(
      row.tagsJson,
      memoryTagsSchema,
      { table: "memories", column: "tags_json", rowId: row.id },
      [],
    ),
    embeddingJson:
      row.embeddingJson === null || row.embeddingJson === undefined
        ? null
        : safeParseJson(
            row.embeddingJson,
            embeddingSchema,
            { table: "memories", column: "embedding_json", rowId: row.id },
            null,
          ),
    metadataJson: safeParseJson(
      row.metadataJson,
      memoryMetadataSchema,
      { table: "memories", column: "metadata_json", rowId: row.id },
      {},
    ),
  } as ParsedMemoryRow & Omit<T, keyof MemoryRowInput>;
}
