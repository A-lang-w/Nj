import { describe, it, expect, beforeAll } from "vitest";
import { Hono } from "hono";
import { db } from "../../src/db/connection.js";
import { sessions, memories } from "../../src/db/schema.js";
import { signToken } from "../../src/auth/tokens.js";
import { favoritesRouter } from "../../src/routes/favorites.js";
import { handleAppError } from "../../src/lib/error-handler.js";

function buildApp() {
  const app = new Hono();
  app.onError(handleAppError);
  app.route("/favorites", favoritesRouter);
  return app;
}

let cookie = "";
const app = buildApp();

beforeAll(async () => {
  const jti = "favorites-test-jti-001";
  await db.insert(sessions).values({
    id: "favorites-test-session-001",
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

describe("favorites route", () => {
  it("lists favorites for the signed-in user", async () => {
    const res = await authed("/favorites");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.items)).toBe(true);
  });

  it("adds and removes a memory favorite", async () => {
    const [memory] = await db
      .insert(memories)
      .values({
        workspaceId: 1,
        content: "favorite-me",
        tagsJson: [],
        metadataJson: {},
      })
      .returning();

    const added = await authed("/favorites", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        targetType: "memory",
        targetId: memory.id,
      }),
    });
    expect(added.status).toBe(201);

    const listed = await authed("/favorites");
    const body = await listed.json();
    expect(
      body.items.some(
        (f: { targetType: string; targetId: number }) =>
          f.targetType === "memory" && f.targetId === memory.id,
      ),
    ).toBe(true);

    const removed = await authed(
      `/favorites?targetType=memory&targetId=${memory.id}`,
      { method: "DELETE" },
    );
    expect(removed.status).toBe(200);

    const after = await authed("/favorites");
    const afterBody = await after.json();
    expect(
      afterBody.items.some(
        (f: { targetType: string; targetId: number }) =>
          f.targetType === "memory" && f.targetId === memory.id,
      ),
    ).toBe(false);
  });

  it("returns 404 for unknown targets", async () => {
    const res = await authed("/favorites", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetType: "thread", targetId: 999999 }),
    });
    expect(res.status).toBe(404);
  });

  it("rejects unauthenticated access", async () => {
    const res = await app.request("/favorites");
    expect(res.status).toBe(401);
  });
});
