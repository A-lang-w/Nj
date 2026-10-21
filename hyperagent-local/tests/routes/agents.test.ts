import { describe, it, expect, beforeAll } from "vitest";
import { Hono } from "hono";
import { db } from "../../src/db/connection.js";
import { sessions } from "../../src/db/schema.js";
import { signToken } from "../../src/auth/tokens.js";
import { agentsRouter } from "../../src/routes/agents.js";
import { handleAppError } from "../../src/lib/error-handler.js";

function buildApp() {
  const app = new Hono();
  app.onError(handleAppError);
  app.route("/agents", agentsRouter);
  return app;
}

let cookie = "";
const app = buildApp();

beforeAll(async () => {
  const jti = "agents-test-jti-001";
  await db.insert(sessions).values({
    id: "agents-test-session-001",
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

describe("agents route CRUD", () => {
  it("lists agents with pagination defaults", async () => {
    const res = await authed("/agents?workspaceId=1");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.items)).toBe(true);
    expect(typeof body.total).toBe("number");
    expect(body.limit).toBeLessThanOrEqual(200);
    expect(body.offset).toBeGreaterThanOrEqual(0);
  });

  it("creates an agent with all optional fields", async () => {
    const res = await authed("/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceId: 1,
        name: "full-agent",
        description: "desc",
        systemPrompt: "prompt",
        model: "claude-opus-5-5",
        temperature: 0.5,
        maxTokens: 2048,
        tools: [{ type: "bash" }],
        iconPath: "/icons/a.png",
      }),
    });
    expect(res.status).toBe(201);
    const agent = await res.json();
    expect(agent.name).toBe("full-agent");
    expect(agent.description).toBe("desc");
    expect(agent.model).toBe("claude-opus-5-5");
    expect(agent.temperature).toBe(0.5);
    expect(agent.maxTokens).toBe(2048);
    expect(agent.iconPath).toBe("/icons/a.png");
  });

  it("updates only supplied fields on PUT", async () => {
    const created = await authed("/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "partial-update",
        systemPrompt: "original",
        description: "keep-me",
      }),
    });
    expect(created.status).toBe(201);
    const agent = await created.json();

    const updated = await authed(`/agents/${agent.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "renamed" }),
    });
    expect(updated.status).toBe(200);
    const body = await updated.json();
    expect(body.name).toBe("renamed");
    expect(body.description).toBe("keep-me");
    expect(body.systemPrompt).toBe("original");
  });

  it("deletes an owned agent and returns 404 on re-delete", async () => {
    const created = await authed("/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "delete-me", systemPrompt: "p" }),
    });
    expect(created.status).toBe(201);
    const agent = await created.json();

    const del = await authed(`/agents/${agent.id}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ success: true });

    const again = await authed(`/agents/${agent.id}`, { method: "DELETE" });
    expect(again.status).toBe(404);
  });

  it("returns 404 for non-existent agent on PUT and DELETE", async () => {
    const put = await authed("/agents/999999", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "nope" }),
    });
    expect(put.status).toBe(404);

    const del = await authed("/agents/999999", { method: "DELETE" });
    expect(del.status).toBe(404);
  });

  it("rejects creation with empty name or systemPrompt", async () => {
    const noName = await authed("/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "", systemPrompt: "p" }),
    });
    expect(noName.status).toBe(400);

    const noPrompt = await authed("/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "x", systemPrompt: "" }),
    });
    expect(noPrompt.status).toBe(400);
  });

  it("clamps pagination parameters to safe bounds", async () => {
    const res = await authed("/agents?workspaceId=1&limit=99999&offset=-10");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.limit).toBeLessThanOrEqual(200);
    expect(body.offset).toBeGreaterThanOrEqual(0);
  });

  it("returns 404 when listing a workspace the caller does not own", async () => {
    const res = await authed("/agents?workspaceId=999999");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not found" });
  });
});
