import { Hono } from "hono";
import { eq, desc, sql, and } from "drizzle-orm";
import { db } from "../db/connection.js";
import { threads, activityEvents } from "../db/schema.js";
import { authMiddleware } from "../auth/middleware.js";
import { resolveRequestWorkspaceId } from "../auth/workspace.js";
import { MAX_PAGINATION_OFFSET } from "../config/constants.js";
import { clampPagination } from "../lib/pagination.js";

export const inboxRouter = new Hono();

inboxRouter.use("/*", authMiddleware);

inboxRouter.get("/summary", async (c) => {
  // SEC-IDOR: Scope to a workspace the caller owns instead of assuming id 1.
  const authWorkspaceId = await resolveRequestWorkspaceId(
    c,
    c.req.query("workspaceId"),
  );
  if (authWorkspaceId == null) return c.json({ error: "Not found" }, 404);
  const workspaceId = authWorkspaceId;

  // No read-state exists yet; report active threads under an honest field name.
  const [activeThreads] = await db
    .select({ count: sql<number>`count(*)` })
    .from(threads)
    .where(
      and(eq(threads.workspaceId, workspaceId), eq(threads.status, "active")),
    );

  const recentActivity = await db
    .select()
    .from(activityEvents)
    .where(eq(activityEvents.workspaceId, workspaceId))
    .orderBy(desc(activityEvents.createdAt))
    .limit(10);

  return c.json({
    activeThreadCount: activeThreads?.count ?? 0,
    recentActivity,
  });
});

inboxRouter.get("/activity", async (c) => {
  // SEC-IDOR: Scope to a workspace the caller owns instead of assuming id 1.
  const authWorkspaceId = await resolveRequestWorkspaceId(
    c,
    c.req.query("workspaceId"),
  );
  if (authWorkspaceId == null) return c.json({ error: "Not found" }, 404);
  const workspaceId = authWorkspaceId;
  const limit = clampPagination(c.req.query("limit"), 50, 200);
  const offset = clampPagination(
    c.req.query("offset"),
    0,
    MAX_PAGINATION_OFFSET,
  );

  const events = await db
    .select()
    .from(activityEvents)
    .where(eq(activityEvents.workspaceId, workspaceId))
    .orderBy(desc(activityEvents.createdAt))
    .limit(limit)
    .offset(offset);

  return c.json(events);
});
