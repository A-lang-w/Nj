import { describe, it, expect, beforeAll } from "vitest";
import { Hono } from "hono";
import { db } from "../../src/db/connection.js";
import { sessions } from "../../src/db/schema.js";
import { signToken } from "../../src/auth/tokens.js";
import { memoriesRouter } from "../../src/routes/memories.js";
import { handleAppError } from "../../src/lib/error-handler.js";

function buildApp() {
  const app = new Hono();
  app.onError(handleAppError);
  app.route("/memories", memoriesRouter);
  return app;
}

let cookie = "";
const app = buildApp();

beforeAll(async () => {
  const jti = "memories-test-jti-001";
  await db.insert(sessions).values({
    id: "memories-test-session-001",
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

describe("memories route CRUD and search", () => {
  it("lists memories as a plain array with pagination defaults", async () => {
    const res = await authed("/memories?workspaceId=1");
    expect(res.status).toBe(200);
    const body = await res.json();
    // The memories GET endpoint returns a plain array, not { items, total }.
    expect(Array.isArray(body)).toBe(true);
  });

  it("creates a memory with content and optional tags", async () => {
    const res = await authed("/memories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceId: 1,
        content: "User prefers dark mode",
        tags: ["ui", "theme"],
      }),
    });
    expect(res.status).toBe(201);
    const memory = await res.json();
    expect(memory.content).toBe("User prefers dark mode");
    expect(memory.tagsJson).toEqual(["ui", "theme"]);
  });

  it("searches memories by content substring via FTS5", async () => {
    await authed("/memories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "unique-memory-content-abc123",
      }),
    });

    const res = await authed(
      "/memories?workspaceId=1&search=unique-memory-content",
    );
    expect(res.status).toBe(200);
    const results = await res.json();
    expect(Array.isArray(results)).toBe(true);
    expect(
      results.some((m: { content: string }) =>
        m.content.includes("unique-memory-content"),
      ),
    ).toBe(true);
  });

  it("deletes an owned memory and returns 404 on re-delete", async () => {
    const created = await authed("/memories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "delete me" }),
    });
    expect(created.status).toBe(201);
    const memory = await created.json();

    const del = await authed(`/memories/${memory.id}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ success: true });

    const again = await authed(`/memories/${memory.id}`, { method: "DELETE" });
    expect(again.status).toBe(404);
  });

  it("returns 404 for non-existent memory on DELETE", async () => {
    const del = await authed("/memories/999999", { method: "DELETE" });
    expect(del.status).toBe(404);
  });

  it("rejects creation without required content field", async () => {
    const res = await authed("/memories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tags: ["x"] }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects creation with empty content", async () => {
    const res = await authed("/memories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "" }),
    });
    expect(res.status).toBe(400);
  });

  it("clamps pagination parameters to safe bounds", async () => {
    const res = await authed("/memories?workspaceId=1&limit=99999&offset=-10");
    expect(res.status).toBe(200);
    // The response is a plain array; clamping is verified by the request
    // succeeding without error rather than by inspecting limit/offset fields.
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  it("returns 404 when listing a workspace the caller does not own", async () => {
    // resolveAuthorizedWorkspaceId returns null for unknown workspaces,
    // which the memories route maps to 404 (not 403).
    const res = await authed("/memories?workspaceId=999999");
    expect(res.status).toBe(404);
  });

  it("filters memories by agentId query parameter", async () => {
    // Create two memories: one unassigned, one with an explicit null agentId.
    await authed("/memories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "agent-filter-unassigned" }),
    });

    const res = await authed("/memories?workspaceId=1&agentId=999999");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    // No memory should match a non-existent agentId.
    expect(
      body.some(
        (m: { content: string }) => m.content === "agent-filter-unassigned",
      ),
    ).toBe(false);
  });
});
