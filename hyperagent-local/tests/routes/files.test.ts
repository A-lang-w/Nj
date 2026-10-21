import { describe, it, expect, beforeAll } from "vitest";
import { Hono } from "hono";
import { db } from "../../src/db/connection.js";
import { sessions, threads } from "../../src/db/schema.js";
import { signToken } from "../../src/auth/tokens.js";
import { filesRouter } from "../../src/routes/files.js";
import { handleAppError } from "../../src/lib/error-handler.js";

function buildApp() {
  const app = new Hono();
  app.onError(handleAppError);
  app.route("/files", filesRouter);
  return app;
}

let cookie = "";
const app = buildApp();

beforeAll(async () => {
  const jti = "files-test-jti-001";
  await db.insert(sessions).values({
    id: "files-test-session-001",
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

describe("files route upload, list, and delete", () => {
  it("lists files with pagination defaults", async () => {
    const res = await authed("/files?workspaceId=1");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  it("uploads a file with multipart form data", async () => {
    const form = new FormData();
    form.append(
      "file",
      new File(["hello world"], "test.txt", { type: "text/plain" }),
    );
    form.append("workspaceId", "1");

    const res = await authed("/files", { method: "POST", body: form });
    expect(res.status).toBe(201);
    const file = await res.json();
    // The files table column is `filename`, not `name`.
    expect(file.filename).toBe("test.txt");
    expect(file.mimeType).toBe("text/plain");
  });

  it("uploads a file bound to a valid thread", async () => {
    const [thread] = await db
      .insert(threads)
      .values({ workspaceId: 1, title: "file-target-thread" })
      .returning();

    const form = new FormData();
    form.append(
      "file",
      new File(["data"], "bound.txt", { type: "text/plain" }),
    );
    form.append("workspaceId", "1");
    form.append("threadId", String(thread.id));

    const res = await authed("/files", { method: "POST", body: form });
    expect(res.status).toBe(201);
    const file = await res.json();
    expect(file.threadId).toBe(thread.id);
  });

  it("rejects upload without multipart content type", async () => {
    const res = await authed("/files", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Expected multipart/form-data content type",
    });
  });

  it("rejects upload without a file field", async () => {
    const form = new FormData();
    form.append("workspaceId", "1");

    const res = await authed("/files", { method: "POST", body: form });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("no file field found");
  });

  it("rejects upload to a non-existent thread", async () => {
    const form = new FormData();
    form.append("file", new File(["x"], "x.txt", { type: "text/plain" }));
    form.append("workspaceId", "1");
    form.append("threadId", "999999");

    const res = await authed("/files", { method: "POST", body: form });
    expect(res.status).toBe(404);
  });

  it("deletes an owned file and returns 404 on re-delete", async () => {
    const form = new FormData();
    form.append(
      "file",
      new File(["del"], "delete-me.txt", { type: "text/plain" }),
    );
    form.append("workspaceId", "1");

    const created = await authed("/files", { method: "POST", body: form });
    expect(created.status).toBe(201);
    const file = await created.json();

    const del = await authed(`/files/${file.id}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ success: true });

    const again = await authed(`/files/${file.id}`, { method: "DELETE" });
    expect(again.status).toBe(404);
  });

  it("returns 404 for non-existent file on DELETE", async () => {
    const res = await authed("/files/999999", { method: "DELETE" });
    expect(res.status).toBe(404);
  });

  it("clamps pagination parameters to safe bounds", async () => {
    const res = await authed("/files?workspaceId=1&limit=99999&offset=-10");
    expect(res.status).toBe(200);
  });

  it("returns 404 when listing a workspace the caller does not own", async () => {
    const res = await authed("/files?workspaceId=999999");
    expect(res.status).toBe(404);
  });
});
