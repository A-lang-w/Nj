import { describe, it, expect, beforeAll } from "vitest";
import { Hono } from "hono";
import { db } from "../../src/db/connection.js";
import { sessions, skills, agents } from "../../src/db/schema.js";
import { signToken } from "../../src/auth/tokens.js";
import { marketplaceRouter } from "../../src/routes/marketplace.js";
import { handleAppError } from "../../src/lib/error-handler.js";

function buildApp() {
  const app = new Hono();
  app.onError(handleAppError);
  app.route("/marketplace", marketplaceRouter);
  return app;
}

let cookie = "";
const app = buildApp();

beforeAll(async () => {
  const jti = "marketplace-test-jti-001";
  await db.insert(sessions).values({
    id: "marketplace-test-session-001",
    userId: 1,
    jti,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
  });
  const token = await signToken({ userId: 1, email: "test@test.com" }, jti);
  cookie = `ha_session=${token}`;

  // Seed a community-approved skill and a community agent for marketplace tests.
  await db.insert(skills).values({
    name: "mp-skill-approved",
    instructions: "do things",
    isCommunity: true,
    approvalStatus: "approved",
    publisherId: 1,
  });
  await db.insert(agents).values({
    name: "mp-agent-community",
    systemPrompt: "prompt",
    workspaceId: 1,
    isCommunity: true,
  });
});

function authed(path: string, init?: RequestInit) {
  return app.request(path, {
    ...init,
    headers: { ...init?.headers, Cookie: cookie },
  });
}

describe("marketplace route listing and detail", () => {
  it("lists community skills by default with pagination", async () => {
    const res = await authed("/marketplace");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.type).toBe("skills");
    expect(Array.isArray(body.items)).toBe(true);
    expect(typeof body.total).toBe("number");
  });

  it("lists community agents when category=agents", async () => {
    const res = await authed("/marketplace?category=agents");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.type).toBe("agents");
    expect(Array.isArray(body.items)).toBe(true);
  });

  it("filters skills by search substring", async () => {
    const res = await authed("/marketplace?search=mp-skill-approved");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(
      body.items.some((s: { name: string }) => s.name === "mp-skill-approved"),
    ).toBe(true);
  });

  it("returns detail for an approved community skill", async () => {
    const list = await authed("/marketplace");
    const first = (await list.json()).items[0] as { id: number };
    const res = await authed(`/marketplace/skills/${first.id}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(first.id);
  });

  it("returns 404 for non-existent skill detail", async () => {
    const res = await authed("/marketplace/skills/999999");
    expect(res.status).toBe(404);
  });

  it("returns detail for a community agent", async () => {
    const list = await authed("/marketplace?category=agents");
    const first = (await list.json()).items[0] as { id: number };
    const res = await authed(`/marketplace/agents/${first.id}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(first.id);
  });

  it("returns 404 for non-existent agent detail", async () => {
    const res = await authed("/marketplace/agents/999999");
    expect(res.status).toBe(404);
  });

  it("returns 400 for invalid detail type", async () => {
    const res = await authed("/marketplace/widgets/1");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid type" });
  });

  it("clamps pagination parameters to safe bounds", async () => {
    const res = await authed("/marketplace?limit=99999&offset=-10");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.items)).toBe(true);
  });

  it("rejects unauthenticated access", async () => {
    const res = await app.request("/marketplace");
    expect(res.status).toBe(401);
  });
});
