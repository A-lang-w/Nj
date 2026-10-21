import { eq, desc, sql } from "drizzle-orm";
import {
  DEFAULT_MAX_TOKENS,
  DEFAULT_MODEL,
  DEFAULT_TEMPERATURE,
} from "../config/constants.js";
import { db } from "../db/connection.js";
import { agents } from "../db/schema.js";
import { Ok, Err, StorageError } from "../lib/result.js";
import type { Result } from "../lib/result.js";

export interface ListAgentsPaginatedInput {
  workspaceId: number;
  limit: number;
  offset: number;
}

export interface ListAgentsPaginatedResult {
  items: Array<typeof agents.$inferSelect>;
  total: number;
}

/**
 * Retrieves a single agent by its numeric identifier.
 *
 * @param id - The agent's primary key.
 * @returns A Result containing the agent record if found, undefined when absent, or a StorageError on failure.
 */
export async function getAgent(
  id: number,
): Promise<Result<typeof agents.$inferSelect | undefined, StorageError>> {
  try {
    const [row] = await db
      .select()
      .from(agents)
      .where(eq(agents.id, id))
      .limit(1);
    return Ok(row);
  } catch (err) {
    return Err(
      new StorageError(
        err instanceof Error ? err.message : "Failed to get agent",
      ),
    );
  }
}

/**
 * Lists agents for a workspace with pagination and total count.
 *
 * @param input - Workspace identifier plus limit/offset for paging.
 * @returns A Result containing the page of agents and the total row count, or a StorageError on failure.
 */
export async function listAgentsPaginated(
  input: ListAgentsPaginatedInput,
): Promise<Result<ListAgentsPaginatedResult, StorageError>> {
  try {
    const whereClause = eq(agents.workspaceId, input.workspaceId);
    const [items, countResult] = await Promise.all([
      db
        .select()
        .from(agents)
        .where(whereClause)
        .orderBy(desc(agents.createdAt))
        .limit(input.limit)
        .offset(input.offset),
      db
        .select({ count: sql<number>`count(*)` })
        .from(agents)
        .where(whereClause),
    ]);
    const total = Number(countResult[0]?.count ?? 0);
    return Ok({ items, total });
  } catch (err) {
    return Err(
      new StorageError(
        err instanceof Error ? err.message : "Failed to list agents",
      ),
    );
  }
}

export interface CreateAgentInput {
  workspaceId: number;
  name: string;
  description?: string | null;
  systemPrompt: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  toolsJson?: unknown[];
  iconPath?: string | null;
  isCommunity?: boolean;
  publisherId?: number | null;
  metadataJson?: Record<string, unknown>;
}

/**
 * Creates a new agent record in the database.
 *
 * @param input - The agent configuration including workspace, name, system prompt, and optional model settings.
 * @returns A Result containing the newly created agent record, or a StorageError if the insert fails.
 */
export async function createAgent(
  input: CreateAgentInput,
): Promise<Result<typeof agents.$inferSelect, StorageError>> {
  try {
    const [agent] = await db
      .insert(agents)
      .values({
        workspaceId: input.workspaceId,
        name: input.name,
        description: input.description ?? null,
        systemPrompt: input.systemPrompt,
        model: input.model ?? DEFAULT_MODEL,
        temperature: input.temperature ?? DEFAULT_TEMPERATURE,
        maxTokens: input.maxTokens ?? DEFAULT_MAX_TOKENS,
        toolsJson: input.toolsJson ?? [],
        iconPath: input.iconPath ?? null,
        isCommunity: input.isCommunity ?? false,
        publisherId: input.publisherId ?? null,
        metadataJson: input.metadataJson ?? {},
      })
      .returning();
    return Ok(agent);
  } catch (err) {
    return Err(
      new StorageError(
        err instanceof Error ? err.message : "Failed to create agent",
      ),
    );
  }
}

/**
 * Lists all agents belonging to a specific workspace.
 *
 * @param workspaceId - The numeric identifier of the workspace whose agents should be returned.
 * @returns A Result containing an array of agent records, or a StorageError if the query fails.
 */
export async function listAgents(
  workspaceId: number,
): Promise<Result<Array<typeof agents.$inferSelect>, StorageError>> {
  try {
    const rows = await db
      .select()
      .from(agents)
      .where(eq(agents.workspaceId, workspaceId));
    return Ok(rows);
  } catch (err) {
    return Err(
      new StorageError(
        err instanceof Error ? err.message : "Failed to list agents",
      ),
    );
  }
}

/**
 * Updates an existing agent's configuration.
 *
 * @param id - The numeric identifier of the agent to update.
 * @param updates - Partial agent fields to merge into the existing record (name, description, system prompt, model settings, etc.).
 * @returns A Result containing the updated agent record, or a StorageError if the update fails.
 */
export async function updateAgent(
  id: number,
  updates: Partial<
    Pick<
      typeof agents.$inferInsert,
      | "name"
      | "description"
      | "systemPrompt"
      | "model"
      | "temperature"
      | "maxTokens"
      | "toolsJson"
      | "iconPath"
      | "isCommunity"
      | "metadataJson"
    >
  >,
): Promise<Result<typeof agents.$inferSelect | undefined, StorageError>> {
  try {
    const [updated] = await db
      .update(agents)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(agents.id, id))
      .returning();
    return Ok(updated);
  } catch (err) {
    return Err(
      new StorageError(
        err instanceof Error ? err.message : "Failed to update agent",
      ),
    );
  }
}

/**
 * Deletes an agent record from the database.
 *
 * @param id - The numeric identifier of the agent to delete.
 * @returns A Result containing void on success, or a StorageError if the delete fails.
 */
export async function deleteAgent(
  id: number,
): Promise<Result<void, StorageError>> {
  try {
    await db.delete(agents).where(eq(agents.id, id));
    return Ok(undefined);
  } catch (err) {
    return Err(
      new StorageError(
        err instanceof Error ? err.message : "Failed to delete agent",
      ),
    );
  }
}
