import {
  DEFAULT_MAX_TOKENS,
  DEFAULT_MODEL,
  DEFAULT_TEMPERATURE,
  MAX_PAGINATION_OFFSET,
} from "../config/constants.js";
import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { zodEnvelopeHook } from "../lib/zod-envelope.js";
import { authMiddleware } from "../auth/middleware.js";
import {
  authorizeResourceOwnership,
  resolveRequestWorkspaceId,
} from "../auth/workspace.js";
import { clampPagination } from "../lib/pagination.js";
import { agents } from "../db/schema.js";
import {
  createAgent,
  updateAgent,
  deleteAgent,
  listAgentsPaginated,
} from "../services/agent-service.js";

const createAgentSchema = z
  .object({
    workspaceId: z.number().int().positive().optional(),
    name: z.string().min(1).max(255),
    description: z.string().max(10000).optional(),
    systemPrompt: z.string().min(1).max(100000),
    model: z.string().min(1).max(255).optional(),
    temperature: z.number().min(0).max(2).optional(),
    maxTokens: z.number().int().positive().max(1000000).optional(),
    tools: z.array(z.record(z.string(), z.unknown())).max(100).optional(),
    iconPath: z.string().max(1024).optional(),
  })
  .strict();

const updateAgentSchema = z
  .object({
    name: z.string().min(1).max(255).optional(),
    description: z.string().max(10000).optional(),
    systemPrompt: z.string().min(1).max(100000).optional(),
    model: z.string().min(1).max(255).optional(),
    temperature: z.number().min(0).max(2).optional(),
    maxTokens: z.number().int().positive().max(1000000).optional(),
    tools: z.array(z.record(z.string(), z.unknown())).max(100).optional(),
    iconPath: z.string().max(1024).optional(),
  })
  .strict();

export const agentsRouter = new Hono();
agentsRouter.use("/*", authMiddleware);

agentsRouter.get("/", async (c) => {
  // SEC-IDOR: Scope to a workspace the caller owns.
  const authWorkspaceId = await resolveRequestWorkspaceId(
    c,
    c.req.query("workspaceId"),
  );
  if (authWorkspaceId == null) return c.json({ error: "Not found" }, 404);
  const limit = clampPagination(c.req.query("limit"), 50, 200);
  const offset = clampPagination(
    c.req.query("offset"),
    0,
    MAX_PAGINATION_OFFSET,
  );

  const result = await listAgentsPaginated({
    workspaceId: authWorkspaceId,
    limit,
    offset,
  });
  if (!result.ok) return c.json({ error: result.error.message }, 500);

  return c.json({
    items: result.value.items,
    total: result.value.total,
    limit,
    offset,
  });
});

agentsRouter.post(
  "/",
  zValidator("json", createAgentSchema, zodEnvelopeHook),
  async (c) => {
    const body = c.req.valid("json");
    // SEC-IDOR: Refuse to create agents in workspaces the caller does not own.
    const authWorkspaceId = await resolveRequestWorkspaceId(
      c,
      body.workspaceId,
    );
    if (authWorkspaceId == null) return c.json({ error: "Not found" }, 404);
    const result = await createAgent({
      workspaceId: authWorkspaceId,
      name: body.name,
      description: body.description ?? "",
      systemPrompt: body.systemPrompt,
      model: body.model ?? DEFAULT_MODEL,
      temperature: body.temperature ?? DEFAULT_TEMPERATURE,
      maxTokens: body.maxTokens ?? DEFAULT_MAX_TOKENS,
      toolsJson: body.tools,
      iconPath: body.iconPath ?? null,
    });
    if (!result.ok) return c.json({ error: result.error.message }, 500);
    return c.json(result.value, 201);
  },
);

agentsRouter.put(
  "/:id",
  zValidator("json", updateAgentSchema, zodEnvelopeHook),
  async (c) => {
    const id = Number(c.req.param("id"));
    const body = c.req.valid("json");

    // SEC-IDOR: Resolve caller's authorized workspace via shared helper,
    // combining ownership check with the lookup in a single query.
    const authWorkspaceId = await authorizeResourceOwnership(
      agents,
      agents.id,
      agents.workspaceId,
      id,
      c,
    );
    if (authWorkspaceId == null) return c.json({ error: "Not found" }, 404);

    // Only write fields the client actually sent: forcing '' / null for
    // omitted keys would wipe the stored description and icon on every
    // partial update (Drizzle skips undefined values in .set()).
    const updates: Parameters<typeof updateAgent>[1] = {};
    if (body.name !== undefined) updates.name = body.name;
    if (body.description !== undefined) updates.description = body.description;
    if (body.systemPrompt !== undefined)
      updates.systemPrompt = body.systemPrompt;
    if (body.model !== undefined) updates.model = body.model;
    if (body.temperature !== undefined) updates.temperature = body.temperature;
    if (body.maxTokens !== undefined) updates.maxTokens = body.maxTokens;
    if (body.tools !== undefined) updates.toolsJson = body.tools;
    if (body.iconPath !== undefined) updates.iconPath = body.iconPath;
    const result = await updateAgent(id, updates);
    if (!result.ok) return c.json({ error: result.error.message }, 500);
    if (!result.value) return c.json({ error: "Not found" }, 404);
    return c.json(result.value);
  },
);

agentsRouter.delete("/:id", async (c) => {
  const id = Number(c.req.param("id"));

  // SEC-IDOR: Resolve caller's authorized workspace via shared helper,
  // combining ownership check with the lookup in a single query.
  const authWorkspaceId = await authorizeResourceOwnership(
    agents,
    agents.id,
    agents.workspaceId,
    id,
    c,
  );
  if (authWorkspaceId == null) return c.json({ error: "Not found" }, 404);

  const result = await deleteAgent(id);
  if (!result.ok) return c.json({ error: result.error.message }, 500);
  return c.json({ success: true });
});
