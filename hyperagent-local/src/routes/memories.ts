import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { zodEnvelopeHook } from "../lib/zod-envelope.js";
import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { agents, memories, threads } from "../db/schema.js";
import { authMiddleware } from "../auth/middleware.js";
import {
  authorizeResourceOwnership,
  resolveAuthorizedWorkspaceId,
  resolveRequestWorkspaceId,
} from "../auth/workspace.js";
import {
  createMemory,
  getMemories,
  searchMemories,
  deleteMemory,
} from "../services/memory-service.js";
import { MAX_PAGINATION_OFFSET } from "../config/constants.js";
import { clampPagination } from "../lib/pagination.js";

const createMemorySchema = z
  .object({
    workspaceId: z.number().int().positive().optional(),
    content: z.string().min(1).max(100000),
    agentId: z.number().int().positive().nullish(),
    sourceThreadId: z.number().int().positive().nullish(),
    tags: z.array(z.string().max(255)).max(100).optional(),
  })
  .strict();

export const memoriesRouter = new Hono();

memoriesRouter.use("/*", authMiddleware);

memoriesRouter.get("/", async (c) => {
  // SEC-IDOR: Scope to a workspace the caller owns.
  const authWorkspaceId = await resolveRequestWorkspaceId(
    c,
    c.req.query("workspaceId"),
  );
  if (authWorkspaceId == null) return c.json({ error: "Not found" }, 404);
  const agentId = c.req.query("agentId")
    ? Number(c.req.query("agentId"))
    : undefined;
  const limit = clampPagination(c.req.query("limit"), 50, 200);
  const offset = clampPagination(
    c.req.query("offset"),
    0,
    MAX_PAGINATION_OFFSET,
  );
  const term = c.req.query("search");

  if (term) {
    const result = await searchMemories(authWorkspaceId, term, limit, offset);
    if (!result.ok) return c.json({ error: result.error.message }, 500);
    return c.json(result.value);
  }
  const result = await getMemories(authWorkspaceId, agentId, limit, offset);
  if (!result.ok) return c.json({ error: result.error.message }, 500);
  return c.json(result.value);
});

memoriesRouter.post(
  "/",
  zValidator("json", createMemorySchema, zodEnvelopeHook),
  async (c) => {
    const body = c.req.valid("json");
    // SEC-IDOR: Refuse to create memories in workspaces the caller does not own.
    const authWorkspaceId = await resolveRequestWorkspaceId(
      c,
      body.workspaceId,
    );
    if (authWorkspaceId == null) return c.json({ error: "Not found" }, 404);
    // SEC-IDOR: bound agent/thread must live in the same authorized workspace.
    if (body.agentId != null) {
      const agentWs = await authorizeResourceOwnership(
        agents,
        agents.id,
        agents.workspaceId,
        body.agentId,
        c,
      );
      if (agentWs === null || agentWs !== authWorkspaceId) {
        return c.json({ error: "Not found" }, 404);
      }
    }
    if (body.sourceThreadId != null) {
      const threadWs = await authorizeResourceOwnership(
        threads,
        threads.id,
        threads.workspaceId,
        body.sourceThreadId,
        c,
      );
      if (threadWs === null || threadWs !== authWorkspaceId) {
        return c.json({ error: "Not found" }, 404);
      }
    }
    const result = await createMemory(
      authWorkspaceId,
      body.content,
      body.agentId ?? undefined,
      body.sourceThreadId ?? undefined,
      body.tags ?? [],
    );
    if (!result.ok) return c.json({ error: result.error.message }, 500);
    return c.json(result.value, 201);
  },
);

memoriesRouter.delete("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  // SEC-IDOR: Verify caller owns the workspace this memory belongs to before deleting.
  const [candidate] = await db
    .select({ workspaceId: memories.workspaceId })
    .from(memories)
    .where(eq(memories.id, id))
    .limit(1);
  const authWorkspaceId = await resolveAuthorizedWorkspaceId(
    c,
    candidate?.workspaceId,
  );
  if (authWorkspaceId == null) return c.json({ error: "Not found" }, 404);
  const result = await deleteMemory(id, authWorkspaceId);
  if (!result.ok) return c.json({ error: result.error.message }, 500);
  return c.json({ success: true });
});
