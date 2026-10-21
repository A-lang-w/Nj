import { describe, it, expect, beforeAll } from "vitest";
import { Hono } from "hono";
import { db } from "../../src/db/connection.js";
import { sessions } from "../../src/db/schema.js";
import { signToken } from "../../src/auth/tokens.js";
import { mcpServersRouter } from "../../src/routes/mcp-servers.js";
import { handleAppError } from "../../src/lib/error-handler.js";

function buildApp() {
  const app = new Hono();
  app.onError(handleAppError);
  app.route("/mcp-servers", mcpServersRouter);
  return app;
}

let cookie = "";
const app = buildApp();

beforeAll(async () => {
  const jti = "mcp-test-jti-001";
  await db.insert(sessions).values({
    id: "mcp-test-session-001",
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

describe("mcp-servers route CRUD", () => {
  it("lists servers scoped to authorized workspace", async () => {
    const res = await authed("/mcp-servers?workspaceId=1");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  it("creates a server with valid config", async () => {
    const res = await authed("/mcp-servers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "test-mcp-server",
        transportType: "stdio",
        config: { command: "node", args: ["server.js"] },
      }),
    });
    expect(res.status).toBe(201);
    const server = await res.json();
    expect(server.name).toBe("test-mcp-server");
    expect(server.transportType).toBe("stdio");
    expect(server.isEnabled).toBe(true);
  });

  it("updates only supplied fields on PUT", async () => {
    const created = await authed("/mcp-servers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "update-target",
        transportType: "sse",
        config: { url: "http://localhost" },
      }),
    });
    const server = await created.json();

    const updated = await authed(`/mcp-servers/${server.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isEnabled: false }),
    });
    expect(updated.status).toBe(200);
    const body = await updated.json();
    expect(body.isEnabled).toBe(false);
    expect(body.name).toBe("update-target");
  });

  it("deletes an owned server and returns 404 on re-delete", async () => {
    const created = await authed("/mcp-servers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "del-mcp",
        transportType: "stdio",
        config: {},
      }),
    });
    const server = await created.json();

    const del = await authed(`/mcp-servers/${server.id}`, { method: "DELETE" });
    expect(del.status).toBe(200);

    const again = await authed(`/mcp-servers/${server.id}`, {
      method: "DELETE",
    });
    expect(again.status).toBe(404);
  });

  it("returns 404 for non-existent server on PUT and DELETE", async () => {
    const put = await authed("/mcp-servers/999999", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "nope" }),
    });
    expect(put.status).toBe(404);

    const del = await authed("/mcp-servers/999999", { method: "DELETE" });
    expect(del.status).toBe(404);
  });

  it("rejects creation with invalid transport type", async () => {
    const res = await authed("/mcp-servers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "bad-transport",
        transportType: "websocket",
        config: {},
      }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects config exceeding max nesting depth", async () => {
    const deep = { a: { b: { c: { d: { e: { f: "too deep" } } } } } };
    const res = await authed("/mcp-servers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "deep-config",
        transportType: "stdio",
        config: deep,
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("nesting exceeds");
  });

  it("rejects creation in unauthorized workspace", async () => {
    const res = await authed("/mcp-servers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceId: 999999,
        name: "unauth-ws",
        transportType: "stdio",
        config: {},
      }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 404 when listing unauthorized workspace", async () => {
    const res = await authed("/mcp-servers?workspaceId=999999");
    expect(res.status).toBe(404);
  });

  it("rejects unauthenticated access", async () => {
    const res = await app.request("/mcp-servers?workspaceId=1");
    expect(res.status).toBe(401);
  });

  it("probes stdio servers and reports non-stdio as unsupported", async () => {
    const stdio = await authed("/mcp-servers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "probe-stdio",
        transportType: "stdio",
        config: {},
      }),
    });
    expect(stdio.status).toBe(201);
    const stdioServer = await stdio.json();

    const stdioProbe = await authed(`/mcp-servers/${stdioServer.id}/probe`, {
      method: "POST",
    });
    expect(stdioProbe.status).toBe(200);
    const stdioBody = await stdioProbe.json();
    expect(stdioBody.ok).toBe(false);
    expect(typeof stdioBody.error).toBe("string");

    const sse = await authed("/mcp-servers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "probe-sse",
        transportType: "sse",
        config: { url: "http://127.0.0.1:9" },
      }),
    });
    const sseServer = await sse.json();
    const sseProbe = await authed(`/mcp-servers/${sseServer.id}/probe`, {
      method: "POST",
    });
    expect(sseProbe.status).toBe(200);
    const sseBody = await sseProbe.json();
    expect(sseBody.ok).toBe(false);
    expect(sseBody.error).toContain("not implemented");

    const missing = await authed("/mcp-servers/999999/probe", {
      method: "POST",
    });
    expect(missing.status).toBe(404);
  });
});
