import { Hono, type Context } from "hono";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { zodEnvelopeHook } from "../lib/zod-envelope.js";
import { authMiddleware } from "../auth/middleware.js";
import { db } from "../db/connection.js";
import { favorites, threads, agents, skills } from "../db/schema.js";
import {
  authorizeResourceOwnership,
  resolveAuthorizedWorkspaceId,
} from "../auth/workspace.js";
import { emitEvent } from "../domain/events.js";

const targetSchema = z
  .object({
    targetType: z.enum(["thread", "agent", "skill"]),
    targetId: z.number().int().positive(),
  })
  .strict();

export const favoritesRouter = new Hono();
favoritesRouter.use("/*", authMiddleware);

favoritesRouter.get("/", async (c) => {
  const auth = c.get("auth");
  const rows = await db
    .select()
    .from(favorites)
    .where(eq(favorites.userId, auth.userId));
  return c.json({ items: rows });
});

favoritesRouter.post(
  "/",
  zValidator("json", targetSchema, zodEnvelopeHook),
  async (c) => {
    const auth = c.get("auth");
    const body = c.req.valid("json");
    const owned = await assertTargetOwned(c, body.targetType, body.targetId);
    if (!owned.ok) return c.json({ error: "Not found" }, 404);

    await db
      .insert(favorites)
      .values({
        userId: auth.userId,
        targetType: body.targetType,
        targetId: body.targetId,
      })
      .onConflictDoNothing();

    emitEvent("favorite.added", {
      workspaceId: owned.workspaceId,
      userId: auth.userId,
      targetType: body.targetType,
      id: body.targetId,
    });
    return c.json({ success: true }, 201);
  },
);

favoritesRouter.delete("/", async (c) => {
  const auth = c.get("auth");
  const targetType = c.req.query("targetType");
  const targetIdRaw = c.req.query("targetId");
  if (
    targetType !== "thread" &&
    targetType !== "agent" &&
    targetType !== "skill"
  ) {
    return c.json({ error: "targetType must be thread, agent, or skill" }, 400);
  }
  const targetId = Number(targetIdRaw);
  if (!Number.isInteger(targetId) || targetId <= 0) {
    return c.json({ error: "targetId must be a positive integer" }, 400);
  }
  const owned = await assertTargetOwned(c, targetType, targetId);
  if (!owned.ok) return c.json({ error: "Not found" }, 404);

  await db
    .delete(favorites)
    .where(
      and(
        eq(favorites.userId, auth.userId),
        eq(favorites.targetType, targetType),
        eq(favorites.targetId, targetId),
      ),
    );

  emitEvent("favorite.removed", {
    workspaceId: owned.workspaceId,
    userId: auth.userId,
    targetType,
    id: targetId,
  });
  return c.json({ success: true });
});

async function assertTargetOwned(
  c: Context,
  targetType: "thread" | "agent" | "skill",
  targetId: number,
): Promise<{ ok: true; workspaceId: number } | { ok: false }> {
  if (targetType === "thread") {
    const ws = await authorizeResourceOwnership(
      threads,
      threads.id,
      threads.workspaceId,
      targetId,
      c,
    );
    return ws == null ? { ok: false } : { ok: true, workspaceId: ws };
  }
  if (targetType === "agent") {
    const ws = await authorizeResourceOwnership(
      agents,
      agents.id,
      agents.workspaceId,
      targetId,
      c,
    );
    return ws == null ? { ok: false } : { ok: true, workspaceId: ws };
  }
  const [skill] = await db
    .select({ workspaceId: skills.workspaceId })
    .from(skills)
    .where(eq(skills.id, targetId))
    .limit(1);
  const ws = await resolveAuthorizedWorkspaceId(c, skill?.workspaceId);
  return ws == null ? { ok: false } : { ok: true, workspaceId: ws };
}
