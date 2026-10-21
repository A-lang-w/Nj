import { describe, it, expect, beforeAll } from "vitest";
import { Hono } from "hono";
import { db } from "../../src/db/connection.js";
import { sessions, threads, activityEvents } from "../../src/db/schema.js";
import { signToken } from "../../src/auth/tokens.js";
import { inboxRouter } from "../../src/routes/inbox.js";
import { handleAppError } from "../../src/lib/error-handler.js";

function buildApp() {
  const app = new Hono();
  app.onError(handleAppError);
  app.route("/inbox", inboxRouter);
  return app;
}

let cookie = "";
const app = buildApp();

beforeAll(async () => {
  const jti = "inbox-test-jti-001";
  await db.insert(sessions).values({
    id: "inbox-test-session-001",
    userId: 1,
    jti,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
  });
  const token = await signToken({ userId: 1, email: "test@test.com" }, jti);
  cookie = `ha_session=${token}`;
});

function authed(path: string, init?: RequestInit) {
  return app.request(path, {
    ...init,
    headers: { ...init?.headers, Cookie: cookie },
  });
}

describe("inbox route summary and activity", () => {
  it("returns summary with activeThreadCount and recentActivity array", async () => {
    const res = await authed("/inbox/summary?workspaceId=1");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.activeThreadCount).toBe("number");
    expect(Array.isArray(body.recentActivity)).toBe(true);
  });

  it("returns 404 for summary when workspace is not owned", async () => {
    const res = await authed("/inbox/summary?workspaceId=999999");
    expect(res.status).toBe(404);
  });

  it("lists activity events with pagination defaults", async () => {
    const res = await authed("/inbox/activity?workspaceId=1");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  it("clamps activity pagination parameters to safe bounds", async () => {
    const res = await authed(
      "/inbox/activity?workspaceId=1&limit=99999&offset=-10",
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  it("returns 404 for activity when workspace is not owned", async () => {
    const res = await authed("/inbox/activity?workspaceId=999999");
    expect(res.status).toBe(404);
  });

  it("defaults workspaceId to 1 when omitted on summary", async () => {
    const res = await authed("/inbox/summary");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.activeThreadCount).toBe("number");
  });

  it("rejects unauthenticated access to summary", async () => {
    const res = await app.request("/inbox/summary?workspaceId=1");
    expect(res.status).toBe(401);
  });

  it("rejects unauthenticated access to activity", async () => {
    const res = await app.request("/inbox/activity?workspaceId=1");
    expect(res.status).toBe(401);
  });
});
