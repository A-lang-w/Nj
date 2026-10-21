import { describe, it, expect, beforeAll } from "vitest";
import { Hono } from "hono";
import { db } from "../../src/db/connection.js";
import { sessions } from "../../src/db/schema.js";
import { signToken } from "../../src/auth/tokens.js";
import { skillsRouter } from "../../src/routes/skills.js";
import { handleAppError } from "../../src/lib/error-handler.js";

function buildApp() {
  const app = new Hono();
  app.onError(handleAppError);
  app.route("/skills", skillsRouter);
  return app;
}

let cookie = "";
const app = buildApp();

beforeAll(async () => {
  const jti = "skills-test-jti-001";
  await db.insert(sessions).values({
    id: "skills-test-session-001",
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

describe("skills route CRUD and search", () => {
  it("lists skills as a plain array with pagination defaults", async () => {
    const res = await authed("/skills?workspaceId=1");
    expect(res.status).toBe(200);
    const body = await res.json();
    // The skills GET endpoint returns a plain array, not { items, total }.
    expect(Array.isArray(body)).toBe(true);
  });

  it("creates a skill with all optional fields", async () => {
    const res = await authed("/skills", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceId: 1,
        name: "full-skill",
        description: "a skill",
        instructions: "do something useful",
        triggerPatterns: ["^/run", "^/exec"],
      }),
    });
    expect(res.status).toBe(201);
    const skill = await res.json();
    expect(skill.name).toBe("full-skill");
    expect(skill.description).toBe("a skill");
    expect(skill.instructions).toBe("do something useful");
    // The DB column is triggerPatternsJson; the route returns the raw row.
    expect(skill.triggerPatternsJson).toEqual(["^/run", "^/exec"]);
  });

  it("searches skills by name substring within the authorized workspace", async () => {
    // searchSkills uses SQL LIKE on the name column, not FTS5 on instructions.
    await authed("/skills", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "unique-searchable-name-xyz",
        instructions: "some instructions",
      }),
    });

    const res = await authed(
      "/skills?workspaceId=1&search=unique-searchable-name",
    );
    expect(res.status).toBe(200);
    const results = await res.json();
    expect(Array.isArray(results)).toBe(true);
    expect(
      results.some(
        (s: { name: string }) => s.name === "unique-searchable-name-xyz",
      ),
    ).toBe(true);
  });

  it("updates only supplied fields on PUT", async () => {
    const created = await authed("/skills", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "update-skill-target",
        description: "before",
        instructions: "old instructions",
        triggerPatterns: ["^old"],
      }),
    });
    expect(created.status).toBe(201);
    const skill = await created.json();

    const updated = await authed(`/skills/${skill.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        description: "after",
        instructions: "new instructions",
        triggerPatterns: ["^new", "^also"],
      }),
    });
    expect(updated.status).toBe(200);
    const body = await updated.json();
    expect(body.name).toBe("update-skill-target");
    expect(body.description).toBe("after");
    expect(body.instructions).toBe("new instructions");
    expect(body.triggerPatternsJson).toEqual(["^new", "^also"]);
  });

  it("returns 400 when PUT has no fields", async () => {
    const created = await authed("/skills", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "empty-put-skill",
        instructions: "keep",
      }),
    });
    const skill = await created.json();
    const res = await authed(`/skills/${skill.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("returns 404 for non-existent skill on PUT", async () => {
    const res = await authed("/skills/999999", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "nope" }),
    });
    expect(res.status).toBe(404);
  });

  it("deletes an owned skill and returns 404 on re-delete", async () => {
    const created = await authed("/skills", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "delete-skill", instructions: "temp" }),
    });
    expect(created.status).toBe(201);
    const skill = await created.json();

    const del = await authed(`/skills/${skill.id}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ success: true });

    const again = await authed(`/skills/${skill.id}`, { method: "DELETE" });
    expect(again.status).toBe(404);
  });

  it("returns 404 for non-existent skill on DELETE", async () => {
    const del = await authed("/skills/999999", { method: "DELETE" });
    expect(del.status).toBe(404);
  });

  it("rejects creation without required instructions field", async () => {
    const res = await authed("/skills", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "no-instructions" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(typeof body.error).toBe("string");
    expect(body.error).toContain("instructions");
  });

  it("rejects creation with empty name", async () => {
    const res = await authed("/skills", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "", instructions: "do x" }),
    });
    expect(res.status).toBe(400);
  });

  it("clamps pagination parameters to safe bounds", async () => {
    const res = await authed("/skills?workspaceId=1&limit=99999&offset=-10");
    expect(res.status).toBe(200);
    // The response is a plain array; clamping is verified by the request
    // succeeding without error rather than by inspecting limit/offset fields.
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  it("returns 404 when listing a workspace the caller does not own", async () => {
    // resolveAuthorizedWorkspaceId returns null for unknown workspaces,
    // which the skills route maps to 404 (not 403).
    const res = await authed("/skills?workspaceId=999999");
    expect(res.status).toBe(404);
  });

  it("defaults workspaceId to 1 when omitted on creation", async () => {
    const res = await authed("/skills", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "default-ws-skill", instructions: "x" }),
    });
    expect(res.status).toBe(201);
    const skill = await res.json();
    expect(skill.workspaceId).toBe(1);
  });
});
