import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { zodEnvelopeHook } from "../lib/zod-envelope.js";
import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { skills } from "../db/schema.js";
import { authMiddleware } from "../auth/middleware.js";
import {
  resolveAuthorizedWorkspaceId,
  resolveRequestWorkspaceId,
} from "../auth/workspace.js";
import {
  createSkill,
  getSkills,
  searchSkills,
  deleteSkill,
} from "../services/skill-service.js";
import { MAX_PAGINATION_OFFSET } from "../config/constants.js";
import { clampPagination } from "../lib/pagination.js";

const createSkillSchema = z
  .object({
    workspaceId: z.number().int().positive().optional(),
    name: z.string().min(1).max(255),
    description: z.string().max(10000).optional(),
    instructions: z.string().min(1).max(100000),
    triggerPatterns: z.array(z.string().max(1024)).max(100).optional(),
  })
  .strict();

export const skillsRouter = new Hono();

skillsRouter.use("/*", authMiddleware);

skillsRouter.get("/", async (c) => {
  const workspaceIdParam = c.req.query("workspaceId");
  // SEC-IDOR: The authorized workspace gates the listing; without it this
  // endpoint previously returned every workspace's skills.
  const authWorkspaceId = await resolveRequestWorkspaceId(c, workspaceIdParam);
  if (authWorkspaceId == null) return c.json({ error: "Not found" }, 404);
  const limit = clampPagination(c.req.query("limit"), 50, 200);
  const offset = clampPagination(
    c.req.query("offset"),
    0,
    MAX_PAGINATION_OFFSET,
  );
  const term = c.req.query("search");

  if (term) {
    const result = await searchSkills(term, limit, authWorkspaceId, offset);
    if (!result.ok) return c.json({ error: result.error.message }, 500);
    return c.json(result.value);
  }
  const result = await getSkills(limit, offset, authWorkspaceId);
  if (!result.ok) return c.json({ error: result.error.message }, 500);
  return c.json(result.value);
});

skillsRouter.post(
  "/",
  zValidator("json", createSkillSchema, zodEnvelopeHook),
  async (c) => {
    const body = c.req.valid("json");
    // Default matches memories/MCP POST: an omitted workspace means the
    // caller's default — ownership is still enforced by the helper.
    const authWorkspaceId = await resolveRequestWorkspaceId(
      c,
      body.workspaceId,
    );
    if (authWorkspaceId === null) {
      return c.json({ error: "Not found" }, 404);
    }
    const result = await createSkill(
      authWorkspaceId,
      body.name,
      body.description ?? "",
      body.instructions,
      body.triggerPatterns ?? [],
    );
    if (!result.ok) return c.json({ error: result.error.message }, 500);
    return c.json(result.value, 201);
  },
);

skillsRouter.delete("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  // SEC-IDOR: Verify caller owns the workspace this skill belongs to before deleting.
  const [candidate] = await db
    .select({ workspaceId: skills.workspaceId })
    .from(skills)
    .where(eq(skills.id, id))
    .limit(1);
  const authWorkspaceId = await resolveAuthorizedWorkspaceId(
    c,
    candidate?.workspaceId,
  );
  if (authWorkspaceId == null) return c.json({ error: "Not found" }, 404);
  const result = await deleteSkill(id, authWorkspaceId);
  if (!result.ok) return c.json({ error: result.error.message }, 500);
  return c.json({ success: true });
});
