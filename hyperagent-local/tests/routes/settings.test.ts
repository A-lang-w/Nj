import { describe, it, expect, beforeAll } from "vitest";
import { Hono } from "hono";
import { db } from "../../src/db/connection.js";
import { sessions, users } from "../../src/db/schema.js";
import { signToken } from "../../src/auth/tokens.js";
import { settingsRouter } from "../../src/routes/settings.js";
import { handleAppError } from "../../src/lib/error-handler.js";

function buildApp() {
  const app = new Hono();
  app.onError(handleAppError);
  app.route("/settings", settingsRouter);
  return app;
}

let cookie = "";
const app = buildApp();

beforeAll(async () => {
  const jti = "settings-test-jti-001";
  await db.insert(sessions).values({
    id: "settings-test-session-001",
    userId: 1,
    jti,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
  });
  // Ensure user row exists for GET /user and PUT /user tests.
  await db
    .insert(users)
    .values({ id: 1, email: "test@test.com", displayName: "Test User" })
    .onConflictDoNothing();
  const token = await signToken({ userId: 1, email: "test@test.com" }, jti);
  cookie = `ha_session=${token}`;
});

function authed(path: string, init?: RequestInit) {
  return app.request(path, {
    ...init,
    headers: { ...init?.headers, Cookie: cookie },
  });
}

describe("settings route user profile and status", () => {
  it("returns the authenticated user profile", async () => {
    const res = await authed("/settings/user");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(1);
    expect(body.email).toBe("test@test.com");
  });

  it("updates displayName with partial patch", async () => {
    const res = await authed("/settings/user", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ displayName: "Updated Name" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.displayName).toBe("Updated Name");
  });

  it("updates settingsJson with a valid plain object", async () => {
    const res = await authed("/settings/user", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ settings: { theme: "dark", fontSize: 14 } }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(JSON.parse(body.settingsJson)).toEqual({
      theme: "dark",
      fontSize: 14,
    });
  });

  it("rejects settings that are not a plain object", async () => {
    const res = await authed("/settings/user", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ settings: [1, 2, 3] }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("plain object");
  });

  it("rejects settings exceeding max nesting depth", async () => {
    const deep = { a: { b: { c: { d: { e: { f: "too deep" } } } } } };
    const res = await authed("/settings/user", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ settings: deep }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("nesting exceeds");
  });

  it("rejects non-string displayName", async () => {
    const res = await authed("/settings/user", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ displayName: 12345 }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("displayName must be a string");
  });

  it("returns feature status flags", async () => {
    const res = await authed("/settings/status");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("active");
    expect(body.features.marketplace).toBe(true);
  });

  it("acknowledges apple account recovery notice", async () => {
    const res = await authed("/settings/apple-account-recovery-notice", {
      method: "POST",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ acknowledged: true });
  });

  it("rejects unauthenticated access to user profile", async () => {
    const res = await app.request("/settings/user");
    expect(res.status).toBe(401);
  });

  it("rejects malformed JSON body on user update", async () => {
    const res = await authed("/settings/user", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "{invalid json",
    });
    expect(res.status).toBe(400);
  });
});
