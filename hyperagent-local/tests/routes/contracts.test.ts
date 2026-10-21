import { describe, it, expect, beforeAll } from "vitest";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../../src/db/connection.js";
import { sessions, users, workspaces, agents } from "../../src/db/schema.js";
import { signToken } from "../../src/auth/tokens.js";
import { inboxRouter } from "../../src/routes/inbox.js";
import { skillsRouter } from "../../src/routes/skills.js";
import { memoriesRouter } from "../../src/routes/memories.js";
import { mcpServersRouter } from "../../src/routes/mcp-servers.js";
import { communityRouter } from "../../src/routes/community.js";
import { marketplaceRouter } from "../../src/routes/marketplace.js";
import { threadsRouter } from "../../src/routes/threads.js";
import { filesRouter } from "../../src/routes/files.js";
import { settingsRouter } from "../../src/routes/settings.js";
import { authRouter } from "../../src/routes/auth.js";
import { agentsRouter } from "../../src/routes/agents.js";
import { integrationsRouter } from "../../src/routes/integrations.js";
import { workspacesRouter } from "../../src/routes/workspaces.js";
import { handleAppError } from "../../src/lib/error-handler.js";

// Route-level contract tests: pagination clamping and create-body validation.
// Auth runs for real against the per-file tmp DB: user 1 / workspace 1 come
// from setup-env fixtures; we add a session row and sign its JWT.
function buildApp() {
  const app = new Hono();
  // Install the production error handler so validator-raised failures take
  // the same path here as in the shipped server.
  app.onError(handleAppError);
  app.route("/inbox", inboxRouter);
  app.route("/skills", skillsRouter);
  app.route("/memories", memoriesRouter);
  app.route("/mcp-servers", mcpServersRouter);
  app.route("/community", communityRouter);
  app.route("/marketplace", marketplaceRouter);
  app.route("/threads", threadsRouter);
  app.route("/files", filesRouter);
  app.route("/settings", settingsRouter);
  app.route("/auth", authRouter);
  app.route("/agents", agentsRouter);
  app.route("/integrations", integrationsRouter);
  app.route("/workspaces", workspacesRouter);
  return app;
}

let cookie = "";
const app = buildApp();

beforeAll(async () => {
  const jti = "route-test-jti-001";
  await db.insert(sessions).values({
    id: "route-test-session-001",
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

describe("route contracts", () => {
  it("rejects unauthenticated requests with 401", async () => {
    const res = await app.request("/inbox/activity");
    expect(res.status).toBe(401);
  });

  it("clamps inbox activity limit and offset", async () => {
    const res = await authed("/inbox/activity?limit=999999&offset=-5");
    expect(res.status).toBe(200);
    const events = await res.json();
    expect(Array.isArray(events)).toBe(true);
    expect(events.length).toBeLessThanOrEqual(200);
  });

  it("renders agent schema failures in the string envelope", async () => {
    const res = await authed("/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ systemPrompt: "x" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(typeof body.error).toBe("string");
    expect(body.error).toContain("name");
    expect(body).not.toHaveProperty("success");
    expect(body).not.toHaveProperty("issues");
  });

  it("renders agent update schema failures in the string envelope", async () => {
    const created = await authed("/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "env-probe", systemPrompt: "s" }),
    });
    expect(created.status).toBe(201);
    const agent = await created.json();
    const res = await authed(`/agents/${agent.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: 123 }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(typeof body.error).toBe("string");
    expect(body.error).toContain("name");
    expect(body).not.toHaveProperty("success");
    expect(body).not.toHaveProperty("issues");
  });

  it("rejects skill creation without a name", async () => {
    const res = await authed("/skills", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instructions: "do things" }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "name: Required" });
  });

  it("creates a skill with a valid body", async () => {
    const res = await authed("/skills", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceId: 1,
        name: "route-skill",
        instructions: "do things",
      }),
    });
    expect(res.status).toBe(201);
    const skill = await res.json();
    expect(skill.name).toBe("route-skill");
    expect(skill.description).toBe("");
  });

  it("rejects memory creation without content", async () => {
    const res = await authed("/memories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tags: ["x"] }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "content: Required" });
  });

  it("creates a memory with a valid body", async () => {
    const res = await authed("/memories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "route-memory" }),
    });
    expect(res.status).toBe(201);
    const memory = await res.json();
    expect(memory.content).toBe("route-memory");
  });

  it("rejects MCP server creation with a bad transport type", async () => {
    const res = await authed("/mcp-servers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "srv",
        transportType: "smoke-signals",
        config: {},
      }),
    });
    expect(res.status).toBe(400);
    const mcpErr = await res.json();
    expect(typeof mcpErr.error).toBe("string");
    expect(mcpErr.error).toContain("transportType");
    expect(mcpErr).not.toHaveProperty("success");
  });

  it("creates an MCP server with a valid body", async () => {
    const res = await authed("/mcp-servers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "route-srv",
        transportType: "stdio",
        config: { cmd: "x" },
      }),
    });
    expect(res.status).toBe(201);
    const server = await res.json();
    expect(server.name).toBe("route-srv");
  });

  it("rejects MCP server partial update with an invalid transport type", async () => {
    const created = await authed("/mcp-servers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "put-srv",
        transportType: "stdio",
        config: {},
      }),
    });
    expect(created.status).toBe(201);
    const server = await created.json();

    const bad = await authed(`/mcp-servers/${server.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transportType: "smoke-signals" }),
    });
    expect(bad.status).toBe(400);
    const putErr = await bad.json();
    expect(typeof putErr.error).toBe("string");
    expect(putErr.error).toContain("transportType");
    expect(putErr).not.toHaveProperty("success");

    const renamed = await authed(`/mcp-servers/${server.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "put-srv-renamed" }),
    });
    expect(renamed.status).toBe(200);
    const updated = await renamed.json();
    expect(updated.name).toBe("put-srv-renamed");
    // Omitted keys are preserved (Drizzle skips undefined in .set()).
    expect(updated.transportType).toBe("stdio");
  });

  it("rejects community skill submission without instructions", async () => {
    const res = await authed("/community/skills/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "no-instructions" }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "instructions: Required" });
  });

  it("accepts a community skill submission with a valid body", async () => {
    const res = await authed("/community/skills/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "route-community-skill",
        instructions: "help",
      }),
    });
    expect(res.status).toBe(201);
    const skill = await res.json();
    expect(skill.name).toBe("route-community-skill");
    expect(skill.isCommunity).toBe(true);
  });

  it("creates a skill in the default workspace when workspaceId is omitted", async () => {
    const res = await authed("/skills", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "route-skill-default-ws",
        instructions: "do things",
      }),
    });
    expect(res.status).toBe(201);
    const skill = await res.json();
    expect(skill.workspaceId).toBe(1);
  });

  it("clamps negative marketplace offset to the first page", async () => {
    const res = await authed("/marketplace?category=skills&offset=-100");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data.items)).toBe(true);
  });

  it("returns the 400 envelope for malformed JSON on thread creation", async () => {
    const res = await authed("/threads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{bad json",
    });
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({
      error: "Malformed JSON in request body",
    });
  });

  it("returns the 400 envelope for malformed JSON on thread messages", async () => {
    const created = await authed("/threads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId: 1, title: "malformed-json-target" }),
    });
    expect(created.status).toBe(201);
    const thread = await created.json();

    const res = await authed(`/threads/${thread.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{bad json",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Malformed JSON in request body",
    });
  });

  it("returns the 400 envelope for malformed JSON on settings update", async () => {
    const res = await authed("/settings/user", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "{bad json",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Malformed JSON in request body",
    });
  });

  it("returns the 400 envelope for malformed JSON on login", async () => {
    const res = await app.request("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{bad json",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Malformed JSON in request body",
    });
  });

  it("returns the 400 envelope for malformed JSON on zValidator routes", async () => {
    // agents/skills/memories/mcp-servers/community parse via Hono's
    // validator, which raises HTTPException(400): the shared handler must
    // preserve the status and render the envelope, not a 500.
    const res = await authed("/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{bad json",
    });
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({
      error: "Malformed JSON in request body",
    });
  });

  it("returns 400 (not 500) for a JSON null body on thread creation", async () => {
    const res = await authed("/threads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "null",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Request body must be an object",
    });
  });

  it("returns 400 (not 201) for a JSON array body on thread creation", async () => {
    // Without a top-level object guard, [] slips through as
    // all-fields-absent and silently creates a default thread.
    const res = await authed("/threads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "[]",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Request body must be an object",
    });
  });

  it("returns 400 (not 500) for a JSON null body on thread messages", async () => {
    const created = await authed("/threads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId: 1, title: "null-body-target" }),
    });
    expect(created.status).toBe(201);
    const thread = await created.json();

    const res = await authed(`/threads/${thread.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "null",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Request body must be an object",
    });
  });

  it("returns 400 (not 500) for a JSON null body on settings update", async () => {
    const res = await authed("/settings/user", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "null",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Request body must be an object",
    });
  });

  it("returns 404 for removed integration sub-paths without assuming a JSON body", async () => {
    // The Slack OAuth endpoint was intentionally removed; unregistered
    // integration sub-paths now fall through to Hono's default 404 handler.
    // This contract asserts only the status code — the body format is not
    // guaranteed when no route matches.
    const res = await authed("/integrations/slack/oauth/status");
    expect(res.status).toBe(404);
  });

  it("rejects thread creation with a non-numeric agentId", async () => {
    const res = await authed("/threads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceId: 1,
        agentId: "abc",
        title: "bad-agent",
      }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "agentId must be a number" });
  });

  it("rejects thread creation with a non-string title", async () => {
    const res = await authed("/threads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId: 1, title: 123 }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "title must be a string" });
  });

  it("rejects thread messages with missing, non-string, or blank content", async () => {
    const created = await authed("/threads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId: 1, title: "validation-target" }),
    });
    expect(created.status).toBe(201);
    const thread = await created.json();

    for (const body of [
      {},
      { content: 123 },
      { content: "   " },
      { content: null },
    ]) {
      const res = await authed(`/threads/${thread.id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: "content must be a non-empty string",
      });
    }
  });

  it("does not clear the shared cookie when a stale token loses a refresh race", async () => {
    // Tab A rotates first (winner); tab B then presents the same original
    // jti (loser). The loser gets 401 but must not clear the cookie jar,
    // which may already hold the winner's fresh cookie. Uses a dedicated
    // session so the shared fixture cookie survives for other tests.
    const raceJti = "route-test-race-jti-001";
    await db.insert(sessions).values({
      id: "route-test-race-session-001",
      userId: 1,
      jti: raceJti,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });
    const raceToken = await signToken(
      { userId: 1, email: "test@test.com" },
      raceJti,
    );
    const raceCookie = `ha_session=${raceToken}`;
    const asRacer = (path: string) =>
      app.request(path, { method: "POST", headers: { Cookie: raceCookie } });

    const winner = await asRacer("/auth/refresh");
    expect(winner.status).toBe(200);
    const winnerCookie = winner.headers.get("set-cookie");
    expect(winnerCookie).toContain("ha_session=");
    const freshCookie = winnerCookie!.match(/ha_session=([^;]+)/)![1];

    const loser = await asRacer("/auth/refresh");
    expect(loser.status).toBe(401);
    expect(await loser.json()).toEqual({ error: "Session no longer valid" });
    const loserCookie = loser.headers.get("set-cookie");
    expect(loserCookie === null || !loserCookie.includes("Max-Age=0")).toBe(
      true,
    );

    // The winner's session survives: its cookie still passes the probe.
    const probe = await app.request("/auth/sessions", {
      headers: { Cookie: `ha_session=${freshCookie}` },
    });
    expect(probe.status).toBe(200);
  });

  it("rejects file uploads naming a missing or malformed thread", async () => {
    for (const threadId of ["abc", "999999"]) {
      const form = new FormData();
      form.append(
        "file",
        new File(["hello"], "hi.txt", { type: "text/plain" }),
      );
      form.append("workspaceId", "1");
      form.append("threadId", threadId);
      const res = await authed("/files", { method: "POST", body: form });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Not found" });
    }
  });

  it("refuses to bind a thread to another workspace agent", async () => {
    const [user2] = await db
      .insert(users)
      .values({ email: "owner2@example.com" })
      .returning();
    const [ws2] = await db
      .insert(workspaces)
      .values({ name: "ws2", ownerId: user2.id })
      .returning();
    const [foreignAgent] = await db
      .insert(agents)
      .values({
        workspaceId: ws2.id,
        name: "private",
        systemPrompt: "secret prompt",
      })
      .returning();
    const [ownAgent] = await db
      .insert(agents)
      .values({
        workspaceId: 1,
        name: "own",
        systemPrompt: "own prompt",
      })
      .returning();

    const foreign = await authed("/threads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceId: 1,
        agentId: foreignAgent.id,
        title: "x",
      }),
    });
    expect(foreign.status).toBe(404);
    expect(await foreign.json()).toEqual({ error: "Not found" });

    const own = await authed("/threads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceId: 1,
        agentId: ownAgent.id,
        title: "y",
      }),
    });
    expect(own.status).toBe(201);
  });

  it("returns 404 for thread detail with a non-numeric or missing id", async () => {
    for (const id of ["abc", "0", "999999"]) {
      const res = await authed(`/threads/${id}`);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Not found" });
    }
  });

  it("returns the full user row on login", async () => {
    // The client stores this payload as its session User: every field the
    // type promises must be present, not just id/email/displayName.
    const res = await app.request("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "fullrow@example.com" }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.user.id).toBeDefined();
    expect(data.user.email).toBe("fullrow@example.com");
    expect(data.user.displayName).toBeDefined();
    expect(data.user).toHaveProperty("avatarPath");
    expect(data.user).toHaveProperty("settingsJson");
    expect(data.user).toHaveProperty("createdAt");
    expect(data.user).toHaveProperty("updatedAt");
  });

  it("provisions a personal workspace on first login and reuses it after", async () => {
    // Without provisioning, a brand-new account owns nothing: the client
    // asks for workspace 1 (or a stale stored id) and 404s every data page.
    // NOTE: login budget is 5/min per IP file-wide; this test spends two.
    const login = (email: string) =>
      app.request("/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
    const first = await login("newworkspace@example.com");
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    expect(typeof firstBody.workspaceId).toBe("number");
    expect(firstBody.workspaceId).not.toBe(1);

    const second = await login("newworkspace@example.com");
    expect(second.status).toBe(200);
    expect((await second.json()).workspaceId).toBe(firstBody.workspaceId);

    // Exactly one workspace row for the new user: no duplicates on repeat login.
    const owned = await db
      .select()
      .from(workspaces)
      .where(eq(workspaces.ownerId, firstBody.user.id));
    expect(owned).toHaveLength(1);
    expect(owned[0].id).toBe(firstBody.workspaceId);

    // End-to-end: the provisioned workspace answers 200 with the login cookie,
    // while workspace 1 stays 404 (owned by the fixture user, not this one).
    const setCookie = first.headers.get("set-cookie") ?? "";
    const headers = { Cookie: setCookie.split(";")[0] };
    const threads = await app.request(
      `/threads?workspaceId=${firstBody.workspaceId}`,
      { headers },
    );
    expect(threads.status).toBe(200);
    const foreign = await app.request("/threads?workspaceId=1", { headers });
    expect(foreign.status).toBe(404);

    // Discovery lists exactly the new workspace for this user.
    const listed = await app.request("/workspaces", { headers });
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual([
      { id: firstBody.workspaceId, name: "Personal" },
    ]);
  });

  it("lists only owned workspaces and requires auth", async () => {
    const res = await authed("/workspaces");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([{ id: 1, name: "Test WS" }]);

    const anon = await app.request("/workspaces");
    expect(anon.status).toBe(401);
  });

  it("lets publishers retract their own community submissions", async () => {
    // Community submissions carry no workspace, so the workspace-scoped
    // skills DELETE 404s on them; retraction needs the publisher-scoped
    // community endpoint. Second user via direct insert: the HTTP login
    // budget is 5/min file-wide and already spent.
    const [user2] = await db
      .insert(users)
      .values({ email: "publisher2@example.com" })
      .returning();
    const jti = "route-test-pub-jti-001";
    await db.insert(sessions).values({
      id: "route-test-pub-session-001",
      userId: user2.id,
      jti,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });
    const token = await signToken(
      { userId: user2.id, email: user2.email },
      jti,
    );
    const pub = (path: string, init?: RequestInit) =>
      app.request(path, {
        ...init,
        headers: {
          ...init?.headers,
          "Content-Type": "application/json",
          Cookie: `ha_session=${token}`,
        },
      });

    const submit = await pub("/community/skills/submit", {
      method: "POST",
      body: JSON.stringify({ name: "retractable", instructions: "do x" }),
    });
    expect(submit.status).toBe(201);
    const { id } = await submit.json();

    // A stranger (fixture user 1) cannot retract it.
    const stranger = await authed(`/community/skills/${id}`, {
      method: "DELETE",
    });
    expect(stranger.status).toBe(404);

    // The publisher can.
    const del = await pub(`/community/skills/${id}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ success: true });

    // Retraction is real: gone from own submissions, second delete 404s.
    const again = await pub(`/community/skills/${id}`, { method: "DELETE" });
    expect(again.status).toBe(404);
    const subs = await pub("/community/skills/submissions");
    expect(subs.status).toBe(200);
    expect((await subs.json()).some((s: { id: number }) => s.id === id)).toBe(
      false,
    );
  });

  it("mints exactly one session under concurrent refresh of one jti", async () => {
    const raceJti = "route-test-par-jti-001";
    await db.insert(sessions).values({
      id: "route-test-par-session-001",
      userId: 1,
      jti: raceJti,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });
    const raceToken = await signToken(
      { userId: 1, email: "test@test.com" },
      raceJti,
    );
    const headers = { Cookie: `ha_session=${raceToken}` };
    const [first, second] = await Promise.all([
      app.request("/auth/refresh", { method: "POST", headers }),
      app.request("/auth/refresh", { method: "POST", headers }),
    ]);
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 401]);
    const loser = first.status === 401 ? first : second;
    const loserCookie = loser.headers.get("set-cookie");
    expect(loserCookie === null || !loserCookie.includes("Max-Age=0")).toBe(
      true,
    );
  });

  it("clears the cookie when the refreshed session is actually expired", async () => {
    const deadJti = "route-test-dead-jti-001";
    await db.insert(sessions).values({
      id: "route-test-dead-session-001",
      userId: 1,
      jti: deadJti,
      expiresAt: new Date(Date.now() - 60 * 1000),
    });
    const deadToken = await signToken(
      { userId: 1, email: "test@test.com" },
      deadJti,
    );
    const res = await app.request("/auth/refresh", {
      method: "POST",
      headers: { Cookie: `ha_session=${deadToken}` },
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toContain("Max-Age=0");
  });
});
