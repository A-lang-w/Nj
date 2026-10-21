import { Hono } from "hono";
import { eq, desc, and, sql } from "drizzle-orm";
import { db } from "../db/connection.js";
import { skills, agents } from "../db/schema.js";
import { authMiddleware } from "../auth/middleware.js";
import { resolveRequestWorkspaceId } from "../auth/workspace.js";
import {
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  MAX_PAGINATION_OFFSET,
} from "../config/constants.js";
import { clampPagination } from "../lib/pagination.js";
import { readJsonBody } from "../lib/json-body.js";

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, "\\$&");
}

export const marketplaceRouter = new Hono();

marketplaceRouter.use("/*", authMiddleware);

marketplaceRouter.get("/", async (c) => {
  const category = c.req.query("category");
  const search = c.req.query("search");
  const requestedLimit = Number(c.req.query("limit"));
  const limit =
    Number.isFinite(requestedLimit) && requestedLimit > 0
      ? Math.min(requestedLimit, MAX_PAGE_LIMIT)
      : DEFAULT_PAGE_LIMIT;
  const offset = clampPagination(
    c.req.query("offset"),
    0,
    MAX_PAGINATION_OFFSET,
  );

  if (category === "agents") {
    const conditions = [eq(agents.isCommunity, true)];
    if (search) {
      // Explicit ESCAPE: Drizzle's like() emits none, leaving \% to match
      // a literal backslash followed by a wildcard in SQLite.
      conditions.push(
        sql`${agents.name} LIKE ${`%${escapeLike(search)}%`} ESCAPE '\\'`,
      );
    }
    const where = and(...conditions);
    const items = await db
      .select()
      .from(agents)
      .where(where)
      .orderBy(desc(agents.createdAt))
      .limit(limit)
      .offset(offset);
    const [countRow] = await db
      .select({ count: sql<number>`count(*)` })
      .from(agents)
      .where(where);
    return c.json({ type: "agents", items, total: countRow?.count ?? 0 });
  }

  const conditions = [
    eq(skills.isCommunity, true),
    eq(skills.approvalStatus, "approved"),
  ];
  if (search) {
    // Explicit ESCAPE: see above.
    conditions.push(
      sql`${skills.name} LIKE ${`%${escapeLike(search)}%`} ESCAPE '\\'`,
    );
  }
  const where = and(...conditions);
  const items = await db
    .select()
    .from(skills)
    .where(where)
    .orderBy(desc(skills.createdAt))
    .limit(limit)
    .offset(offset);
  const [countRow] = await db
    .select({ count: sql<number>`count(*)` })
    .from(skills)
    .where(where);
  return c.json({ type: "skills", items, total: countRow?.count ?? 0 });
});

marketplaceRouter.get("/:type/:id", async (c) => {
  const type = c.req.param("type");
  const id = Number(c.req.param("id"));

  if (type === "skills") {
    // SEC-IDOR: Detail must honor the same visibility predicates as the
    // list handler, or private instructions leak by id enumeration.
    const [skill] = await db
      .select()
      .from(skills)
      .where(
        and(
          eq(skills.id, id),
          eq(skills.isCommunity, true),
          eq(skills.approvalStatus, "approved"),
        ),
      );
    if (!skill) return c.json({ error: "Not found" }, 404);
    return c.json(skill);
  }

  if (type === "agents") {
    // SEC-IDOR: Same as above — community rows only, or private
    // system prompts leak by id enumeration.
    const [agent] = await db
      .select()
      .from(agents)
      .where(and(eq(agents.id, id), eq(agents.isCommunity, true)));
    if (!agent) return c.json({ error: "Not found" }, 404);
    return c.json(agent);
  }

  return c.json({ error: "Invalid type" }, 400);
});

// Local-mode install: copies a community skill or agent into the caller's
// personal workspace as a non-community, approved item. Community items in
// local mode are auto-approved at submission time (see community.ts), so
// any item returned by the marketplace GET is safe to copy. External
// downloads are not supported; this endpoint only clones DB rows.
marketplaceRouter.post("/:type/:id/install", async (c) => {
  const type = c.req.param("type");
  const id = Number(c.req.param("id"));

  // Prefer an explicit authorized workspaceId from the JSON body; otherwise
  // the caller's personal workspace. Empty/non-JSON bodies stay valid for
  // back-compat with clients that POST with no body.
  let bodyWorkspaceId: number | undefined;
  const contentType = c.req.header("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const parsed = await readJsonBody<{ workspaceId?: number }>(c);
    if (!parsed.ok) return c.json({ error: parsed.error.message }, 400);
    bodyWorkspaceId = parsed.value.workspaceId;
  }
  const authWorkspaceId = await resolveRequestWorkspaceId(c, bodyWorkspaceId);
  if (authWorkspaceId == null) {
    return c.json({ error: "No workspace found" }, 400);
  }

  if (type === "skills") {
    const [source] = await db
      .select()
      .from(skills)
      .where(
        and(
          eq(skills.id, id),
          eq(skills.isCommunity, true),
          eq(skills.approvalStatus, "approved"),
        ),
      );
    if (!source) return c.json({ error: "Not found" }, 404);

    const [installed] = await db
      .insert(skills)
      .values({
        workspaceId: authWorkspaceId,
        name: source.name,
        description: source.description,
        instructions: source.instructions,
        triggerPatternsJson: source.triggerPatternsJson,
        isCommunity: false,
        approvalStatus: "approved",
        metadataJson: source.metadataJson,
      })
      .returning();
    return c.json({ success: true, item: installed });
  }

  if (type === "agents") {
    const [source] = await db
      .select()
      .from(agents)
      .where(and(eq(agents.id, id), eq(agents.isCommunity, true)));
    if (!source) return c.json({ error: "Not found" }, 404);

    const [installed] = await db
      .insert(agents)
      .values({
        workspaceId: authWorkspaceId,
        name: source.name,
        description: source.description,
        systemPrompt: source.systemPrompt,
        model: source.model,
        temperature: source.temperature,
        maxTokens: source.maxTokens,
        toolsJson: source.toolsJson,
        iconPath: source.iconPath,
        isCommunity: false,
        metadataJson: source.metadataJson,
      })
      .returning();
    return c.json({ success: true, item: installed });
  }

  return c.json({ error: "Invalid type" }, 400);
});
