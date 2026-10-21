import { eq, desc, and, sql } from "drizzle-orm";
import { DEFAULT_PAGE_LIMIT } from "../config/constants.js";
import { db } from "../db/connection.js";
import { skills } from "../db/schema.js";
import { emitEvent } from "../domain/events.js";
import {
  safeParseJson,
  skillTriggerPatternsSchema,
  skillMetadataSchema,
} from "../db/validators.js";
import { Ok, Err, StorageError } from "../lib/result.js";
import type { Result } from "../lib/result.js";

/**
 * Creates a new skill record in the database.
 *
 * @param workspaceId - The numeric identifier of the workspace that owns the skill.
 * @param name - The unique name of the skill within the workspace.
 * @param description - A human-readable description of what the skill does.
 * @param instructions - The system-level instructions executed when the skill is triggered.
 * @param triggerPatterns - Optional list of glob or regex patterns that activate this skill.
 * @returns A Result containing the newly created skill record, or a StorageError if the insert fails.
 * @emits skill.created with the id of the newly created skill.
 */
export async function createSkill(
  workspaceId: number,
  name: string,
  description: string,
  instructions: string,
  triggerPatterns: string[] = [],
): Promise<Result<typeof skills.$inferSelect, StorageError>> {
  try {
    const [skill] = await db
      .insert(skills)
      .values({
        workspaceId,
        name,
        description,
        instructions,
        // mode: 'json' columns stringify on write; pass the value, not text.
        triggerPatternsJson: triggerPatterns,
        isCommunity: false,
        approvalStatus: "approved",
      })
      .returning();
    emitEvent("skill.created", { id: skill.id, workspaceId });
    return Ok(skill);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to create skill";
    if (/UNIQUE|unique/i.test(message)) {
      return Err(
        new StorageError(
          `A skill named "${name}" already exists in this workspace`,
        ),
      );
    }
    return Err(new StorageError(message));
  }
}

/**
 * Retrieves a paginated list of skills ordered by creation date (newest first).
 *
 * @param limit - Maximum number of skill records to return (default 50).
 * @param offset - Number of records to skip for pagination (default 0).
 * @param workspaceId - Optional workspace scope; when provided, only skills
 *   owned by that workspace are returned. Routes must pass the authorized id.
 * @returns A Result containing an array of skill records with parsed trigger patterns and metadata, or a StorageError if the query fails.
 */
export async function getSkills(
  limit = DEFAULT_PAGE_LIMIT,
  offset = 0,
  workspaceId?: number,
): Promise<
  Result<
    Array<
      typeof skills.$inferSelect & {
        triggerPatternsJson: string[];
        metadataJson: Record<string, unknown>;
      }
    >,
    StorageError
  >
> {
  try {
    const rows = await db
      .select()
      .from(skills)
      .where(
        workspaceId === undefined
          ? undefined
          : eq(skills.workspaceId, workspaceId),
      )
      .orderBy(desc(skills.createdAt))
      .limit(limit)
      .offset(offset);

    return Ok(
      rows.map((row) => ({
        ...row,
        triggerPatternsJson: safeParseJson(
          row.triggerPatternsJson,
          skillTriggerPatternsSchema,
          { table: "skills", column: "trigger_patterns_json", rowId: row.id },
          [],
        ),
        metadataJson: safeParseJson(
          row.metadataJson,
          skillMetadataSchema,
          { table: "skills", column: "metadata_json", rowId: row.id },
          {},
        ),
      })),
    );
  } catch (err) {
    return Err(
      new StorageError(
        err instanceof Error ? err.message : "Failed to retrieve skills",
      ),
    );
  }
}

/**
 * Searches for skills whose name matches a SQL LIKE pattern.
 *
 * @param term - The substring or pattern to match against skill names (%, _, and \ are escaped).
 * @param limit - Maximum number of matching records to return (default 20).
 * @param workspaceId - Optional workspace scope; when provided, only skills
 *   owned by that workspace are returned. Routes must pass the authorized id.
 * @returns A Result containing an array of matching skill records with parsed trigger patterns and metadata, or a StorageError if the query fails.
 */
export async function searchSkills(
  term: string,
  limit = 20,
  workspaceId?: number,
  offset = 0,
): Promise<
  Result<
    Array<
      typeof skills.$inferSelect & {
        triggerPatternsJson: string[];
        metadataJson: Record<string, unknown>;
      }
    >,
    StorageError
  >
> {
  try {
    const escaped = term.replace(/[%_\\]/g, "\\$&");
    // Drizzle's like() emits no ESCAPE clause, so the backslash above would
    // match literally; spell out the escape explicitly for SQLite.
    const nameMatch = sql`${skills.name} LIKE ${`%${escaped}%`} ESCAPE '\\'`;
    const rows = await db
      .select()
      .from(skills)
      .where(
        workspaceId === undefined
          ? nameMatch
          : and(nameMatch, eq(skills.workspaceId, workspaceId)),
      )
      .orderBy(desc(skills.createdAt))
      .limit(limit)
      .offset(offset);

    return Ok(
      rows.map((row) => ({
        ...row,
        triggerPatternsJson: safeParseJson(
          row.triggerPatternsJson,
          skillTriggerPatternsSchema,
          { table: "skills", column: "trigger_patterns_json", rowId: row.id },
          [],
        ),
        metadataJson: safeParseJson(
          row.metadataJson,
          skillMetadataSchema,
          { table: "skills", column: "metadata_json", rowId: row.id },
          {},
        ),
      })),
    );
  } catch (err) {
    return Err(
      new StorageError(
        err instanceof Error ? err.message : "Failed to search skills",
      ),
    );
  }
}

/**
 * Deletes a skill record from the database.
 *
 * @param skillId - The numeric identifier of the skill to delete.
 * @param workspaceId - Authorized workspace that must own the skill (defense in depth).
 * @returns A Result containing void on success, or a StorageError if the delete fails.
 * @emits skill.deleted with the id of the deleted skill.
 */
export async function updateSkill(
  skillId: number,
  workspaceId: number,
  updates: {
    name?: string;
    description?: string | null;
    instructions?: string;
    triggerPatterns?: string[];
  },
): Promise<Result<typeof skills.$inferSelect | null, StorageError>> {
  try {
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (updates.name !== undefined) patch.name = updates.name;
    if (updates.description !== undefined)
      patch.description = updates.description;
    if (updates.instructions !== undefined)
      patch.instructions = updates.instructions;
    if (updates.triggerPatterns !== undefined)
      patch.triggerPatternsJson = updates.triggerPatterns;
    const [updated] = await db
      .update(skills)
      .set(patch)
      .where(and(eq(skills.id, skillId), eq(skills.workspaceId, workspaceId)))
      .returning();
    if (updated) {
      emitEvent("skill.updated", {
        id: skillId,
        workspaceId: updated.workspaceId,
      });
    }
    return Ok(updated ?? null);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to update skill";
    if (/UNIQUE|unique/i.test(message) && updates.name) {
      return Err(
        new StorageError(
          `A skill named "${updates.name}" already exists in this workspace`,
        ),
      );
    }
    return Err(new StorageError(message));
  }
}

export async function deleteSkill(
  skillId: number,
  workspaceId: number,
): Promise<Result<void, StorageError>> {
  try {
    const deleted = await db
      .delete(skills)
      .where(and(eq(skills.id, skillId), eq(skills.workspaceId, workspaceId)))
      .returning({ id: skills.id, workspaceId: skills.workspaceId });
    if (deleted.length > 0) {
      emitEvent("skill.deleted", {
        id: skillId,
        workspaceId: deleted[0].workspaceId,
      });
    }
    return Ok(undefined);
  } catch (err) {
    return Err(
      new StorageError(
        err instanceof Error ? err.message : "Failed to delete skill",
      ),
    );
  }
}
