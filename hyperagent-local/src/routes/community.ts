import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { zodEnvelopeHook } from "../lib/zod-envelope.js";
import { eq, desc, and } from "drizzle-orm";
import { db } from "../db/connection.js";
import { skills } from "../db/schema.js";
import { authMiddleware } from "../auth/middleware.js";
import { emitEvent } from "./events.js";
import { MAX_PAGINATION_OFFSET } from "../config/constants.js";
import { clampPagination } from "../lib/pagination.js";
import { createRateLimiter } from "../lib/rate-limiter.js";

// SEC-COMMUNITY: Dedicated rate limiter for community skill submissions.
// 10 submissions per minute per user prevents automated bulk uploads while
// allowing normal interactive use. Keyed by userId since all routes require
// authentication and IP-based limiting would be ineffective in local mode.
const submitRateLimiter = createRateLimiter({
  windowMs: 60_000,
  maxAttempts: 10,
});

const submitCommunitySkillSchema = z
  .object({
    name: z.string().min(1).max(255),
    description: z.string().max(10000).optional(),
    instructions: z.string().min(1).max(100000),
    triggerPatterns: z.array(z.string().max(1024)).max(100).optional(),
  })
  .strict();

const skillIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

export const communityRouter = new Hono();

communityRouter.use("/*", authMiddleware);

communityRouter.get("/skills/submissions", async (c) => {
  const auth = c.get("auth");
  const submissions = await db
    .select()
    .from(skills)
    .where(eq(skills.publisherId, auth.userId))
    .orderBy(desc(skills.createdAt));
  return c.json(submissions);
});

communityRouter.get("/skills/approved", async (c) => {
  const limit = clampPagination(c.req.query("limit"), 50, 200);
  const offset = clampPagination(
    c.req.query("offset"),
    0,
    MAX_PAGINATION_OFFSET,
  );
  const approved = await db
    .select()
    .from(skills)
    .where(
      and(eq(skills.isCommunity, true), eq(skills.approvalStatus, "approved")),
    )
    .orderBy(desc(skills.createdAt))
    .limit(limit)
    .offset(offset);
  return c.json(approved);
});

// Local mode: single-user environment has no RBAC boundary, so community
// skill submissions are auto-approved at insert time. The approve endpoint
// remains as an idempotent confirmation; reject sets approvalStatus.
communityRouter.post(
  "/skills/submit",
  zValidator("json", submitCommunitySkillSchema, zodEnvelopeHook),
  async (c) => {
    const auth = c.get("auth");

    // SEC-COMMUNITY: Per-user rate limit checked after auth so we can key by
    // userId. Placed before body processing to reject abusive callers early
    // and avoid parsing/validation cost on throttled requests.
    if (!submitRateLimiter.check(String(auth.userId))) {
      return c.json(
        { error: "Too many submissions. Please wait before trying again." },
        429,
      );
    }

    const body = c.req.valid("json");
    const [skill] = await db
      .insert(skills)
      .values({
        name: body.name,
        description: body.description,
        instructions: body.instructions,
        // mode: 'json' columns stringify on write; pass the value, not text.
        triggerPatternsJson: body.triggerPatterns ?? [],
        isCommunity: true,
        publisherId: auth.userId,
        approvalStatus: "approved",
      })
      .returning();
    emitEvent("community.skill.submitted", { id: skill.id });
    emitEvent("community.skill.approved", { id: skill.id });
    return c.json(skill, 201);
  },
);

// Idempotent confirmation for callers that still issue an explicit approve.
communityRouter.put(
  "/skills/:id/approve",
  zValidator("param", skillIdParamSchema),
  async (c) => {
    const { id } = c.req.valid("param");
    const auth = c.get("auth");
    // SEC-IDOR: Only the publisher may transition their own submission;
    // otherwise any authenticated user could approve arbitrary skills.
    const [updated] = await db
      .update(skills)
      .set({ approvalStatus: "approved", updatedAt: new Date() })
      .where(and(eq(skills.id, id), eq(skills.publisherId, auth.userId)))
      .returning();
    if (!updated) return c.json({ error: "Not found" }, 404);
    emitEvent("community.skill.approved", { id });
    return c.json(updated);
  },
);

// Retraction: community submissions carry no workspace (global namespace),
// so the workspace-scoped skills DELETE 404s on them. Without this endpoint
// a submitter could never remove their own submission. Publisher-scoped
// like approve; workspace skills (NULL publisher) can never match.
communityRouter.delete(
  "/skills/:id",
  zValidator("param", skillIdParamSchema),
  async (c) => {
    const { id } = c.req.valid("param");
    const auth = c.get("auth");
    // SEC-IDOR: The conditional delete is the arbiter — no TOCTOU between a
    // separate ownership check and the delete.
    const [deleted] = await db
      .delete(skills)
      .where(and(eq(skills.id, id), eq(skills.publisherId, auth.userId)))
      .returning({ id: skills.id });
    if (!deleted) return c.json({ error: "Not found" }, 404);
    emitEvent("skill.deleted", { id: deleted.id });
    return c.json({ success: true });
  },
);

// Publisher-scoped reject: there is no separate reviewer role in local mode,
// but the status transition is real so callers are not lied to.
communityRouter.put(
  "/skills/:id/reject",
  zValidator("param", skillIdParamSchema),
  async (c) => {
    const { id } = c.req.valid("param");
    const auth = c.get("auth");
    // SEC-IDOR: Only the publisher may reject their own submission.
    const [updated] = await db
      .update(skills)
      .set({ approvalStatus: "rejected", updatedAt: new Date() })
      .where(and(eq(skills.id, id), eq(skills.publisherId, auth.userId)))
      .returning();
    if (!updated) return c.json({ error: "Not found" }, 404);
    emitEvent("community.skill.rejected", { id });
    return c.json(updated);
  },
);
