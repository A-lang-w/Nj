import { eq, desc, and, sql } from "drizzle-orm";
import { DEFAULT_PAGE_LIMIT } from "../config/constants.js";
import { db } from "../db/connection.js";
import { memories } from "../db/schema.js";
import { emitEvent } from "../domain/events.js";
import { parseMemoryRow, type ParsedMemoryRow } from "../db/validators.js";
import { Ok, Err, StorageError } from "../lib/result.js";
import type { Result } from "../lib/result.js";

/**
 * Creates a new memory entry within a workspace and emits a creation event.
 *
 * @param workspaceId - The numeric identifier of the workspace that owns the memory.
 * @param content - The textual content of the memory to persist.
 * @param agentId - Optional agent identifier to associate with the memory; pass `null` or omit for unassigned memories.
 * @param sourceThreadId - Optional thread identifier indicating where the memory originated; pass `null` or omit when unrelated to a thread.
 * @param tags - Optional list of string tags for categorization; defaults to an empty array.
 * @returns The newly created memory row as returned by the database, including its generated `id`.
 * @throws Propagates any database error from the underlying insert operation.
 * @emits `memory.created` with `{ id, workspaceId }` after successful insertion.
 */
export async function createMemory(
  workspaceId: number,
  content: string,
  agentId?: number | null,
  sourceThreadId?: number | null,
  tags: string[] = [],
): Promise<Result<typeof memories.$inferSelect, StorageError>> {
  try {
    const [memory] = await db
      .insert(memories)
      .values({
        workspaceId,
        agentId: agentId ?? null,
        sourceThreadId: sourceThreadId ?? null,
        content,
        // mode: 'json' columns stringify on write; pass the value, not text.
        tagsJson: tags,
      })
      .returning();
    emitEvent("memory.created", { id: memory.id, workspaceId });
    return Ok(memory);
  } catch (err) {
    return Err(
      new StorageError(
        err instanceof Error ? err.message : "Failed to create memory",
      ),
    );
  }
}

/**
 * Retrieves a paginated list of memories for a workspace, optionally filtered by agent.
 *
 * @param workspaceId - The numeric identifier of the workspace whose memories to retrieve.
 * @param agentId - Optional agent identifier to filter results; pass `null` or omit to include all agents.
 * @param limit - Maximum number of memories to return; defaults to `50`.
 * @param offset - Number of memories to skip for pagination; defaults to `0`.
 * @returns An array of memory rows with parsed `tagsJson`, `embeddingJson`, and `metadataJson` fields, ordered by most recently created.
 * @throws Propagates any database error from the underlying select operation.
 */
export async function getMemories(
  workspaceId: number,
  agentId?: number | null,
  limit = DEFAULT_PAGE_LIMIT,
  offset = 0,
): Promise<Result<ParsedMemoryRow[], StorageError>> {
  try {
    const conditions = [eq(memories.workspaceId, workspaceId)];
    if (agentId !== undefined && agentId !== null) {
      conditions.push(eq(memories.agentId, agentId));
    }
    const rows = await db
      .select()
      .from(memories)
      .where(and(...conditions))
      .orderBy(desc(memories.createdAt))
      .limit(limit)
      .offset(offset);

    return Ok(rows.map(parseMemoryRow));
  } catch (err) {
    return Err(
      new StorageError(
        err instanceof Error ? err.message : "Failed to retrieve memories",
      ),
    );
  }
}

/**
 * Searches memories within a workspace using an FTS5 full-text query, optionally limited by count.
 *
 * @param workspaceId - The numeric identifier of the workspace whose memories to search.
 * @param term - The textual search term(s); each whitespace-separated token is quoted for phrase-safe substring matching.
 * @param limit - Maximum number of matching memories to return; defaults to `20`.
 * @param offset - Number of matching memories to skip for pagination; defaults to `0`.
 * @returns An array of memory rows matching the FTS5 query, with parsed `tagsJson`, `embeddingJson`, and `metadataJson` fields, ordered by most recently created. Returns an empty array when the sanitized query is empty.
 * @throws Propagates any database error from the underlying select operation.
 */
export async function searchMemories(
  workspaceId: number,
  term: string,
  limit = 20,
  offset = 0,
): Promise<Result<ParsedMemoryRow[], StorageError>> {
  try {
    // Sanitize FTS5 query: wrap each token in quotes for phrase-safe substring matching
    const ftsQuery = term
      .split(/\s+/)
      .filter(Boolean)
      .map((t) => `"${t.replace(/"/g, '""')}"`)
      .join(" OR ");
    if (!ftsQuery) {
      return Ok([]);
    }
    const rows = await db
      .select({
        id: memories.id,
        workspaceId: memories.workspaceId,
        agentId: memories.agentId,
        content: memories.content,
        sourceThreadId: memories.sourceThreadId,
        tagsJson: memories.tagsJson,
        embeddingJson: memories.embeddingJson,
        metadataJson: memories.metadataJson,
        createdAt: memories.createdAt,
        updatedAt: memories.updatedAt,
      })
      .from(memories)
      .innerJoin(sql`memories_fts`, sql`memories_fts.rowid = ${memories.id}`)
      .where(
        and(
          eq(memories.workspaceId, workspaceId),
          sql`memories_fts MATCH ${ftsQuery}`,
        ),
      )
      .orderBy(desc(memories.createdAt))
      .limit(limit)
      .offset(offset);

    return Ok(rows.map(parseMemoryRow));
  } catch (err) {
    return Err(
      new StorageError(
        err instanceof Error ? err.message : "Failed to search memories",
      ),
    );
  }
}

/**
 * Deletes a memory entry by its identifier and emits a deletion event.
 *
 * @param memoryId - The numeric identifier of the memory to delete.
 * @param workspaceId - Authorized workspace that must own the memory (defense in depth).
 * @returns Resolves with `void` after the row is removed and the event is emitted.
 * @throws Propagates any database error from the underlying delete operation.
 * @emits `memory.deleted` with `{ id }` after successful deletion.
 */
export async function deleteMemory(
  memoryId: number,
  workspaceId: number,
): Promise<Result<void, StorageError>> {
  try {
    const deleted = await db
      .delete(memories)
      .where(
        and(eq(memories.id, memoryId), eq(memories.workspaceId, workspaceId)),
      )
      .returning({ id: memories.id, workspaceId: memories.workspaceId });
    // Match file-service: deleting a missing row is a successful no-op, but
    // subscribers must not receive a phantom deletion for a row that never existed.
    if (deleted.length > 0) {
      emitEvent("memory.deleted", {
        id: memoryId,
        workspaceId: deleted[0].workspaceId,
      });
    }
    return Ok(undefined);
  } catch (err) {
    return Err(
      new StorageError(
        err instanceof Error ? err.message : "Failed to delete memory",
      ),
    );
  }
}
