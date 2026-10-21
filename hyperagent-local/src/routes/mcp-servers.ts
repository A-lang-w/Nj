import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { zodEnvelopeHook } from "../lib/zod-envelope.js";
import { eq, desc, and } from "drizzle-orm";
import { db } from "../db/connection.js";
import { mcpServers } from "../db/schema.js";
import { authMiddleware } from "../auth/middleware.js";
import {
  resolveAuthorizedWorkspaceId,
  resolveRequestWorkspaceId,
} from "../auth/workspace.js";
import { validateBoundedObject } from "../lib/bounded-object.js";
import { emitEvent } from "./events.js";
import {
  probeSseMcpServer,
  probeStdioMcpServer,
  probeStreamableHttpMcpServer,
} from "../services/mcp-runtime.js";

const createMcpServerSchema = z
  .object({
    workspaceId: z.number().int().positive().optional(),
    name: z.string().min(1).max(255),
    transportType: z.enum(["stdio", "sse", "streamable-http"]),
    config: z.record(z.string(), z.unknown()),
    isEnabled: z.boolean().optional(),
  })
  .strict();

const updateMcpServerSchema = z
  .object({
    name: z.string().min(1).max(255).optional(),
    transportType: z.enum(["stdio", "sse", "streamable-http"]).optional(),
    config: z.record(z.string(), z.unknown()).optional(),
    isEnabled: z.boolean().optional(),
  })
  .strict();

export const mcpServersRouter = new Hono();

mcpServersRouter.use("/*", authMiddleware);

mcpServersRouter.get("/", async (c) => {
  // SEC-IDOR: Scope to a workspace the caller owns.
  const authWorkspaceId = await resolveRequestWorkspaceId(
    c,
    c.req.query("workspaceId"),
  );
  if (authWorkspaceId == null) return c.json({ error: "Not found" }, 404);
  const servers = await db
    .select()
    .from(mcpServers)
    .where(eq(mcpServers.workspaceId, authWorkspaceId))
    .orderBy(desc(mcpServers.createdAt));
  return c.json(servers);
});

mcpServersRouter.post(
  "/",
  zValidator("json", createMcpServerSchema, zodEnvelopeHook),
  async (c) => {
    const body = c.req.valid("json");
    // Bounded config validation prevents resource exhaustion from deeply
    // nested or oversized payloads stored as JSON. Mirrors settings.ts limits.
    const configCheck = validateBoundedObject(body.config, "config", 5, 200);
    if (!configCheck.ok) return c.json({ error: configCheck.error }, 400);
    // SEC-IDOR: Refuse to create servers in workspaces the caller does not own.
    const authWorkspaceId = await resolveRequestWorkspaceId(
      c,
      body.workspaceId,
    );
    if (authWorkspaceId == null) return c.json({ error: "Not found" }, 404);
    const [server] = await db
      .insert(mcpServers)
      .values({
        workspaceId: authWorkspaceId,
        name: body.name,
        transportType: body.transportType,
        // mode: 'json' columns stringify on write; pass the value, not text.
        configJson: body.config,
        isEnabled: body.isEnabled ?? true,
      })
      .returning();
    emitEvent("mcp_server.created", {
      id: server.id,
      workspaceId: authWorkspaceId,
    });
    return c.json(server, 201);
  },
);

mcpServersRouter.put(
  "/:id",
  zValidator("json", updateMcpServerSchema, zodEnvelopeHook),
  async (c) => {
    const id = Number(c.req.param("id"));
    // SEC-IDOR: Verify caller owns the workspace this MCP server belongs to before updating.
    const [candidate] = await db
      .select({ workspaceId: mcpServers.workspaceId })
      .from(mcpServers)
      .where(eq(mcpServers.id, id))
      .limit(1);
    const authWorkspaceId = await resolveAuthorizedWorkspaceId(
      c,
      candidate?.workspaceId,
    );
    if (authWorkspaceId == null) return c.json({ error: "Not found" }, 404);
    const body = c.req.valid("json");
    // Bounded config validation prevents resource exhaustion from deeply
    // nested or oversized payloads stored as JSON. Mirrors settings.ts limits.
    if (body.config !== undefined) {
      const configCheck = validateBoundedObject(body.config, "config", 5, 200);
      if (!configCheck.ok) return c.json({ error: configCheck.error }, 400);
    }
    const [updated] = await db
      .update(mcpServers)
      .set({
        name: body.name,
        transportType: body.transportType,
        configJson: body.config,
        isEnabled: body.isEnabled,
        updatedAt: new Date(),
      })
      .where(
        and(eq(mcpServers.id, id), eq(mcpServers.workspaceId, authWorkspaceId)),
      )
      .returning();
    // A concurrent delete can land between the candidate check and this
    // update: no row means 404 (like agents PUT), not a 200-empty plus a
    // phantom updated event. No deterministic test — the window is a race.
    if (!updated) return c.json({ error: "Not found" }, 404);
    emitEvent("mcp_server.updated", { id, workspaceId: authWorkspaceId });
    return c.json(updated);
  },
);

mcpServersRouter.post("/:id/probe", async (c) => {
  const id = Number(c.req.param("id"));
  const [server] = await db
    .select()
    .from(mcpServers)
    .where(eq(mcpServers.id, id))
    .limit(1);
  const authWorkspaceId = await resolveAuthorizedWorkspaceId(
    c,
    server?.workspaceId,
  );
  if (authWorkspaceId == null || !server) {
    return c.json({ error: "Not found" }, 404);
  }
  const config =
    server.configJson != null &&
    typeof server.configJson === "object" &&
    !Array.isArray(server.configJson)
      ? (server.configJson as Record<string, unknown>)
      : {};
  if (server.transportType === "stdio") {
    return c.json(await probeStdioMcpServer(server.name, config));
  }
  if (server.transportType === "sse") {
    return c.json(await probeSseMcpServer(server.name, config));
  }
  if (server.transportType === "streamable-http") {
    return c.json(await probeStreamableHttpMcpServer(server.name, config));
  }
  return c.json(
    {
      ok: false,
      serverName: server.name,
      transportType: server.transportType,
      tools: [],
      error: `unsupported transport ${server.transportType}`,
    },
    200,
  );
});

mcpServersRouter.delete("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  // SEC-IDOR: Verify caller owns the workspace this MCP server belongs to before deleting.
  const [candidate] = await db
    .select({ workspaceId: mcpServers.workspaceId })
    .from(mcpServers)
    .where(eq(mcpServers.id, id))
    .limit(1);
  const authWorkspaceId = await resolveAuthorizedWorkspaceId(
    c,
    candidate?.workspaceId,
  );
  if (authWorkspaceId == null) return c.json({ error: "Not found" }, 404);
  await db
    .delete(mcpServers)
    .where(
      and(eq(mcpServers.id, id), eq(mcpServers.workspaceId, authWorkspaceId)),
    );
  emitEvent("mcp_server.deleted", { id, workspaceId: authWorkspaceId });
  return c.json({ success: true });
});
