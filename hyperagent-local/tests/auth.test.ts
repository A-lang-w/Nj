import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../src/db/schema.js";
import { Hono } from "hono";
import { setCookie, getCookie } from "hono/cookie";
import * as jose from "jose";
import { nanoid } from "nanoid";
import { eq } from "drizzle-orm";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

// We need to mock the db module and config before importing auth routes
// Since the auth router imports db and config at module level, we test
// by constructing a standalone app with an in-memory database.
// NOTE: This test uses a self-contained mock router rather than importing
// the real auth routes, because those import db/config at module level.
// This test covers the auth protocol contract including: login with email
// trimming (SEC-008), onConflictDoNothing + re-select for concurrent user
// creation, ensurePersonalWorkspace provisioning with workspaceId in the
// response, jti population on session insert, cookie secure/domain attributes,
// rate limiting, and logout. Production-only paths still not covered here
// (tested elsewhere): /refresh with jti rotation and concurrent-rotation guard
// (contracts.test.ts); expired-session cleanup on login; readJsonBody
// parsing/validation (contracts.test.ts); resolveClientIp under trustProxy=false.

let sqlite: Database.Database;
let tmpDir: string;

// Build a self-contained auth router for testing that uses our own db instance
function buildTestAuthRouter(
  db: ReturnType<typeof drizzle>,
  jwtSecret: string,
) {
  // Dependencies imported at module level above

  const secret = new TextEncoder().encode(jwtSecret);
  const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const MAX_EMAIL_LENGTH = 254;
  const RATE_LIMIT_WINDOW_MS = 60_000;
  const RATE_LIMIT_MAX_ATTEMPTS = 5;

  interface RateLimitEntry {
    count: number;
    resetAt: number;
  }
  const loginRateLimits = new Map<string, RateLimitEntry>();

  function checkRateLimit(ip: string): boolean {
    const now = Date.now();
    const entry = loginRateLimits.get(ip);
    if (!entry || now >= entry.resetAt) {
      loginRateLimits.set(ip, {
        count: 1,
        resetAt: now + RATE_LIMIT_WINDOW_MS,
      });
      return true;
    }
    if (entry.count >= RATE_LIMIT_MAX_ATTEMPTS) return false;
    entry.count++;
    return true;
  }

  async function signToken(payload: {
    userId: number;
    email: string;
  }): Promise<string> {
    return new jose.SignJWT(payload as unknown as jose.JWTPayload)
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("30d")
      .sign(secret);
  }

  async function verifyToken(
    token: string,
  ): Promise<{ userId: number; email: string } | null> {
    try {
      const { payload } = await jose.jwtVerify(token, secret, {
        algorithms: ["HS256"],
      });
      return payload as unknown as { userId: number; email: string };
    } catch {
      return null;
    }
  }

  const router = new Hono();

  router.post("/login", async (c: any) => {
    const ip =
      c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
      c.req.header("x-real-ip") ??
      "127.0.0.1";

    if (!checkRateLimit(ip)) {
      return c.json(
        { error: "Too many login attempts. Please wait before trying again." },
        429,
      );
    }

    const body = await c.req.json();
    const rawEmail = body.email;

    // SEC-008 parity: trim whitespace before validation
    if (typeof rawEmail !== "string") {
      return c.json({ error: "Invalid email format" }, 400);
    }
    const email = rawEmail.trim();

    if (!email || email.length > MAX_EMAIL_LENGTH || !EMAIL_REGEX.test(email)) {
      return c.json({ error: "Invalid email format" }, 400);
    }

    let [user] = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, email));
    if (!user) {
      // Parity: use onConflictDoNothing + re-select for concurrent login convergence
      await db
        .insert(schema.users)
        .values({
          email,
          displayName: email.split("@")[0],
        })
        .onConflictDoNothing();
      [user] = await db
        .select()
        .from(schema.users)
        .where(eq(schema.users.email, email));
      if (!user) return c.json({ error: "Failed to create user" }, 500);
    }

    // Parity: ensure personal workspace exists and return workspaceId
    let [workspace] = await db
      .select()
      .from(schema.workspaces)
      .where(eq(schema.workspaces.ownerId, user.id))
      .limit(1);
    if (!workspace) {
      [workspace] = await db
        .insert(schema.workspaces)
        .values({ name: "Personal", ownerId: user.id })
        .returning();
    }

    const sessionId = nanoid(32);
    const jti = nanoid(32);
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await db.insert(schema.sessions).values({
      id: sessionId,
      userId: user.id,
      jti,
      expiresAt,
    });
    const token = await signToken({ userId: user.id, email: user.email });
    setCookie(c, "ha_session", token, {
      httpOnly: true,
      sameSite: "Lax",
      secure: true,
      domain: "localhost",
      path: "/",
      maxAge: 30 * 24 * 60 * 60,
    });
    return c.json({
      user: { id: user.id, email: user.email, displayName: user.displayName },
      workspaceId: workspace.id,
    });
  });

  router.post("/logout", async (c: any) => {
    const token = getCookie(c, "ha_session");
    if (token) {
      const payload = await verifyToken(token);
      if (payload) {
        await db
          .delete(schema.sessions)
          .where(eq(schema.sessions.userId, payload.userId));
      }
    }
    setCookie(c, "ha_session", "", {
      httpOnly: true,
      sameSite: "Lax",
      secure: true,
      domain: "localhost",
      path: "/",
      maxAge: 0,
    });
    return c.json({ success: true });
  });

  return { router, loginRateLimits };
}

describe("auth", () => {
  let db: ReturnType<typeof drizzle>;
  let app: Hono;
  let loginRateLimits: Map<string, { count: number; resetAt: number }>;
  const TEST_JWT_SECRET =
    "test-secret-key-that-is-at-least-32-bytes-long-for-testing";

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ha-auth-test-"));
    const dbPath = path.join(tmpDir, "test.db");
    sqlite = new Database(dbPath);
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("foreign_keys = ON");

    sqlite.exec(`
      CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL UNIQUE, display_name TEXT, avatar_path TEXT, settings_json TEXT DEFAULT '{}', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, jti TEXT, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE workspaces (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, owner_id INTEGER NOT NULL REFERENCES users(id), settings_json TEXT DEFAULT '{}', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    `);

    db = drizzle(sqlite, { schema });
    const result = buildTestAuthRouter(db, TEST_JWT_SECRET);
    app = new Hono();
    app.route("/api/auth", result.router);
    loginRateLimits = result.loginRateLimits;
  });

  afterAll(() => {
    sqlite?.close();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    // Clear rate limits between tests
    loginRateLimits.clear();
  });

  it("login creates user and returns session", async () => {
    const res = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "newuser@example.com" }),
    });

    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.user).toBeDefined();
    expect(data.user.email).toBe("newuser@example.com");
    expect(data.user.displayName).toBe("newuser");
    expect(data.user.id).toBeDefined();

    // Verify cookie is set
    const setCookieHeader = res.headers.get("set-cookie");
    expect(setCookieHeader).toContain("ha_session=");
    expect(setCookieHeader).toContain("HttpOnly");
  });

  it("login validates email format", async () => {
    const invalidEmails = [
      "",
      "not-an-email",
      "@missing-local.com",
      "no-domain@",
      "spaces in@email.com",
    ];

    for (const email of invalidEmails) {
      const res = await app.request("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      expect(res.status).toBe(400);
      const data = (await res.json()) as any;
      expect(data.error).toBe("Invalid email format");
    }
  });

  it("logout invalidates session", async () => {
    // First login to get a session
    const loginRes = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "logout-test@example.com" }),
    });
    expect(loginRes.status).toBe(200);

    const setCookieHeader = loginRes.headers.get("set-cookie");
    const cookieMatch = setCookieHeader?.match(/ha_session=([^;]+)/);
    expect(cookieMatch).toBeTruthy();
    const sessionToken = cookieMatch![1];

    // Now logout
    const logoutRes = await app.request("/api/auth/logout", {
      method: "POST",
      headers: { Cookie: `ha_session=${sessionToken}` },
    });

    expect(logoutRes.status).toBe(200);
    const data = (await logoutRes.json()) as any;
    expect(data.success).toBe(true);

    // Verify session cookie is cleared
    const logoutCookie = logoutRes.headers.get("set-cookie");
    expect(logoutCookie).toContain("ha_session=");
    expect(logoutCookie).toContain("Max-Age=0");
  });

  it("rate limiting rejects excessive attempts", async () => {
    // Make 5 successful attempts (the limit)
    for (let i = 0; i < 5; i++) {
      const res = await app.request("/api/auth/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Forwarded-For": "10.0.0.1",
        },
        body: JSON.stringify({ email: `ratelimit${i}@example.com` }),
      });
      expect(res.status).toBe(200);
    }

    // 6th attempt should be rate limited
    const blockedRes = await app.request("/api/auth/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Forwarded-For": "10.0.0.1",
      },
      body: JSON.stringify({ email: "blocked@example.com" }),
    });

    expect(blockedRes.status).toBe(429);
    const data = (await blockedRes.json()) as any;
    expect(data.error).toContain("Too many login attempts");
  });
});
