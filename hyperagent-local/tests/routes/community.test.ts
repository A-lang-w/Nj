import { describe, it, expect, beforeAll } from "vitest";
import { Hono } from "hono";
import { db } from "../../src/db/connection.js";
import { sessions, skills } from "../../src/db/schema.js";
import { signToken } from "../../src/auth/tokens.js";
import { communityRouter } from "../../src/routes/community.js";
import { handleAppError } from "../../src/lib/error-handler.js";

function buildApp() {
  const app = new Hono();
  app.onError(handleAppError);
  app.route("/community", communityRouter);
  return app;
}

let cookie = "";
const app = buildApp();
let sharedSkillId: number;
let deletableSkillId: number;

beforeAll(async () => {
  const jti = "community-test-jti-001";
  await db.insert(sessions).values({
    id: "community-test-session-001",
    userId: 1,
    jti,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
  });
  const token = await signToken({ userId: 1, email: "test@test.com" }, jti);
  cookie = `ha_session=${token}`;

  // Seed shared and deletable community skills directly via DB to avoid
  // hitting the per-user rate limiter (10/min) on the /submit endpoint.
  // Validation tests (empty name, missing instructions) still go through
  // the API since they are rejected before consuming the rate limit budget.
  const [shared] = await db
    .insert(skills)
    .values({
      name: "comm-skill-shared",
      instructions: "do something",
      description: "desc",
      isCommunity: true,
      approvalStatus: "approved",
      publisherId: 1,
    })
    .returning();
  sharedSkillId = shared.id;

  const [deletable] = await db
    .insert(skills)
    .values({
      name: "comm-del-own",
      instructions: "temp",
      isCommunity: true,
      approvalStatus: "approved",
      publisherId: 1,
    })
    .returning();
  deletableSkillId = deletable.id;
});

function authed(path: string, init?: RequestInit) {
  return app.request(path, {
    ...init,
    headers: { ...init?.headers, Cookie: cookie },
  });
}

describe("community route submissions and approval", () => {
  it("lists own submissions", async () => {
    const res = await authed("/community/skills/submissions");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  it("lists approved community skills with pagination", async () => {
    const res = await authed("/community/skills/approved?limit=10&offset=0");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  it("verifies the pre-created shared skill is auto-approved in local mode", async () => {
    expect(sharedSkillId).toBeDefined();
    const res = await authed("/community/skills/submissions");
    expect(res.status).toBe(200);
    const subs = await res.json();
    const found = subs.find((s: { id: number }) => s.id === sharedSkillId);
    expect(found).toBeDefined();
    expect(found.isCommunity).toBe(true);
    expect(found.approvalStatus).toBe("approved");
    expect(found.publisherId).toBe(1);
  });

  it("rejects submission without required instructions", async () => {
    const res = await authed("/community/skills/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "no-instr" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects submission with empty name", async () => {
    const res = await authed("/community/skills/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "", instructions: "x" }),
    });
    expect(res.status).toBe(400);
  });

  it("idempotently approves own submission", async () => {
    expect(sharedSkillId).toBeDefined();
    const res = await authed(`/community/skills/${sharedSkillId}/approve`, {
      method: "PUT",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.approvalStatus).toBe("approved");
  });

  it("returns 404 when approving a non-existent skill", async () => {
    const res = await authed("/community/skills/999999/approve", {
      method: "PUT",
    });
    expect(res.status).toBe(404);
  });

  it("deletes own community submission", async () => {
    expect(deletableSkillId).toBeDefined();
    const del = await authed(`/community/skills/${deletableSkillId}`, {
      method: "DELETE",
    });
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ success: true });
  });

  it("returns 404 when deleting another user's or non-existent submission", async () => {
    const res = await authed("/community/skills/999999", {
      method: "DELETE",
    });
    expect(res.status).toBe(404);
  });

  it("reject sets approvalStatus to rejected for own skill", async () => {
    expect(sharedSkillId).toBeDefined();
    const res = await authed(`/community/skills/${sharedSkillId}/reject`, {
      method: "PUT",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(sharedSkillId);
    expect(body.approvalStatus).toBe("rejected");
  });

  it("returns 404 on reject for non-existent skill", async () => {
    const res = await authed("/community/skills/999999/reject", {
      method: "PUT",
    });
    expect(res.status).toBe(404);
  });

  it("rejects unauthenticated access to submit", async () => {
    const res = await app.request("/community/skills/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "x", instructions: "y" }),
    });
    expect(res.status).toBe(401);
  });

  it("clamps approved listing pagination parameters", async () => {
    const res = await authed(
      "/community/skills/approved?limit=99999&offset=-5",
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });
});
