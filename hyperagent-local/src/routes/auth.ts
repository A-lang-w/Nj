import { Hono } from "hono";
import { setCookie, getCookie } from "hono/cookie";
import { signToken, verifyTokenSignature } from "../auth/tokens.js";
import { authMiddleware } from "../auth/middleware.js";
import { db } from "../db/connection.js";
import { users, sessions } from "../db/schema.js";
import { nanoid } from "nanoid";
import { config } from "../config.js";
import { eq, lt, and } from "drizzle-orm";
import { createRateLimiter } from "../lib/rate-limiter.js";
import { resolveClientIp } from "../lib/client-ip.js";
import { readJsonBody } from "../lib/json-body.js";
import { ensurePersonalWorkspace } from "../services/workspace-service.js";

// SEC-004: Local-only device-bound authentication for single-user use.
// This is intentionally passwordless — the tool runs locally on a personal machine
// with no network exposure. Email serves as a stable user identifier, not a credential.
// Rate limiting prevents automated abuse if the local server is accidentally exposed.
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LENGTH = 254;

// SEC-012: Login-specific rate limiter using shared factory.
const loginRateLimiter = createRateLimiter({
  windowMs: 60_000,
  maxAttempts: 5,
});

// SEC-013: Refresh-specific rate limiter keyed by userId to prevent token replay abuse.
// Stricter than login (5/min per user) since refresh is a sensitive operation that issues new credentials.
const refreshRateLimiter = createRateLimiter({
  windowMs: 60_000,
  maxAttempts: 5,
});

export const authRouter = new Hono();

/** Session cookie attrs. Omit Domain when unset so the cookie is host-only. */
function sessionCookieAttrs(maxAge: number): {
  httpOnly: true;
  sameSite: "Lax";
  secure: boolean;
  path: "/";
  maxAge: number;
  domain?: string;
} {
  const attrs: {
    httpOnly: true;
    sameSite: "Lax";
    secure: boolean;
    path: "/";
    maxAge: number;
    domain?: string;
  } = {
    httpOnly: true,
    // Lax: top-level navigations (bookmarks, automation, external links into
    // the local UI) must carry the session. Strict dropped the cookie on
    // those loads and painted a false "session ended" after a hard refresh.
    sameSite: "Lax",
    secure: config.cookieSecure,
    path: "/",
    maxAge,
  };
  if (config.cookieDomain) attrs.domain = config.cookieDomain;
  return attrs;
}

authRouter.post("/login", async (c) => {
  const ip = resolveClientIp(c);

  if (!loginRateLimiter.check(ip)) {
    return c.json(
      { error: "Too many login attempts. Please wait before trying again." },
      429,
    );
  }

  const parsed = await readJsonBody(c);
  if (!parsed.ok) return c.json({ error: parsed.error.message }, 400);
  const body = parsed.value;
  const rawEmail = body.email;

  // SEC-008: Input validation — trim whitespace before validation to prevent
  // bypass via leading/trailing spaces that pass length checks but fail downstream.
  if (typeof rawEmail !== "string") {
    return c.json({ error: "Invalid email format" }, 400);
  }
  const email = rawEmail.trim();

  if (!email || email.length > MAX_EMAIL_LENGTH || !EMAIL_REGEX.test(email)) {
    return c.json({ error: "Invalid email format" }, 400);
  }

  // Lazy cleanup: remove expired sessions to prevent unbounded database growth
  await db.delete(sessions).where(lt(sessions.expiresAt, new Date()));

  let [user] = await db.select().from(users).where(eq(users.email, email));
  if (!user) {
    // Concurrent fresh-email logins race here: both selects miss, then the
    // loser's insert hits unique(email) and 500s. Insert-or-ignore and
    // re-read so losers converge on the winner's row instead of failing.
    await db
      .insert(users)
      .values({
        email,
        displayName: email.split("@")[0],
      })
      .onConflictDoNothing();
    [user] = await db.select().from(users).where(eq(users.email, email));
    // Unreachable: no endpoint deletes users, so the row exists now.
    if (!user) return c.json({ error: "Failed to create user" }, 500);
  }
  // Every account needs an owned workspace: without one the client asks
  // for workspace 1 (or a stale stored id) and 404s every data page with
  // no recovery. Provision here so login is the convergence point.
  const workspace = await ensurePersonalWorkspace(user.id);
  if (!workspace.ok) return c.json({ error: workspace.error.message }, 500);
  const sessionId = nanoid(32);
  const jti = nanoid(32);
  const expiresAt = new Date(
    Date.now() + config.sessionMaxAgeDays * 24 * 60 * 60 * 1000,
  );
  await db.insert(sessions).values({
    id: sessionId,
    userId: user.id,
    jti,
    expiresAt,
  });
  const token = await signToken({ userId: user.id, email: user.email }, jti);
  // SEC-005/SEC-007: Cookie hardening for local-only deployment.
  // Host-only (no Domain) so 127.0.0.1 and localhost each keep their own jar.
  // SameSite=Lax keeps the session on top-level navigations; CSRF is limited
  // by loopback binding and passwordless local-only threat model.
  setCookie(
    c,
    "ha_session",
    token,
    sessionCookieAttrs(config.sessionMaxAgeDays * 24 * 60 * 60),
  );
  // Return the full row: the client stores this as its session user, and a
  // 3-field pick would leave settingsJson/avatarPath/timestamps undefined
  // behind the User type. The row carries no secrets (passwordless app).
  // workspaceId is additive: the client adopts it as the active workspace
  // so a brand-new account never 404s against workspace 1 or stale storage.
  return c.json({ user, workspaceId: workspace.value.id });
});
authRouter.post("/logout", async (c) => {
  const token = getCookie(c, "ha_session");
  if (token) {
    // Signature-only check: logout must clear sessions even when the JWT
    // itself has expired, since expiry is precisely why users log back in.
    const payload = await verifyTokenSignature(token);
    if (payload) {
      // Scope to this cookie's session only: other devices/tabs for the same
      // user keep their live jti rows. Match refresh, which keys on userId+jti.
      await db
        .delete(sessions)
        .where(
          and(
            eq(sessions.userId, payload.userId),
            eq(sessions.jti, payload.jti),
          ),
        );
    }
  }
  setCookie(c, "ha_session", "", sessionCookieAttrs(0));
  return c.json({ success: true });
});
// SEC-011: Token refresh endpoint with single-use rotation. Validates the
// current JWT's jti claim against the sessions table, deletes the old
// session row, creates a new session with a fresh jti, and issues a new
// short-lived JWT. This prevents replay of stolen tokens after rotation:
// once a token is refreshed, its jti is invalidated atomically.
authRouter.post("/refresh", async (c) => {
  const token = getCookie(c, "ha_session");
  if (!token) {
    return c.json({ error: "No session token" }, 401);
  }

  // Signature-only verification: the presented JWT may be past its 1-hour
  // life — renewing it is this endpoint's purpose. Freshness is enforced
  // below via the session row's jti match and expiresAt check.
  const payload = await verifyTokenSignature(token);
  // SEC-013: Apply per-user rate limit for refresh to prevent token replay abuse.
  // Keyed by userId so compromised tokens cannot be used to exhaust global limits.
  if (payload) {
    if (!refreshRateLimiter.check(String(payload.userId))) {
      return c.json({ error: "Too many refresh attempts" }, 429);
    }
  }
  if (!payload) {
    setCookie(c, "ha_session", "", sessionCookieAttrs(0));
    return c.json({ error: "Invalid or expired token" }, 401);
  }

  // Verify the session exists, matches this token's jti, and has not expired.
  // The jti check ensures single-use rotation: if another client already
  // refreshed using this token, the old session row (and its jti) is gone.
  const [session] = await db
    .select()
    .from(sessions)
    .where(
      and(eq(sessions.userId, payload.userId), eq(sessions.jti, payload.jti)),
    );

  if (!session) {
    // The jti is gone: another tab already rotated this token, and the
    // shared cookie jar may now hold the winner's fresh cookie. Returning
    // 401 without clearing lets the loser re-read the current cookie and
    // retry; clearing here would log the whole browser out while a live
    // session row remains.
    return c.json({ error: "Session no longer valid" }, 401);
  }
  if (session.expiresAt < new Date()) {
    // The session is actually dead: invalidate the cookie with it.
    setCookie(c, "ha_session", "", sessionCookieAttrs(0));
    return c.json({ error: "Session no longer valid" }, 401);
  }

  // Atomic rotation: delete the old session and create a new one with a
  // fresh jti. This invalidates the presented token immediately. The delete
  // is conditional on id+jti and checks its own row count: two concurrent
  // refreshes of one jti both pass the select above, but exactly one delete
  // removes the row, so the loser observes zero rows and stops before
  // minting a second live session. No transaction is needed — each
  // better-sqlite3 statement executes atomically; only the gaps yield.
  const deleted = await db
    .delete(sessions)
    .where(and(eq(sessions.id, session.id), eq(sessions.jti, payload.jti)))
    .returning({ id: sessions.id });
  if (deleted.length === 0) {
    // Lost a concurrent rotation: another refresh already consumed this
    // jti. 401 without clearing — the winner's cookie may be in the jar.
    return c.json({ error: "Session no longer valid" }, 401);
  }

  const newSessionId = nanoid(32);
  const newJti = nanoid(32);
  const expiresAt = new Date(
    Date.now() + config.sessionMaxAgeDays * 24 * 60 * 60 * 1000,
  );
  await db.insert(sessions).values({
    id: newSessionId,
    userId: payload.userId,
    jti: newJti,
    expiresAt,
  });

  const newToken = await signToken(
    { userId: payload.userId, email: payload.email },
    newJti,
  );
  // Preserve the session lifetime: the cookie must survive as long as the
  // session row does, otherwise idle users lose silent refresh after an hour.
  const remainingMaxAge = Math.max(
    60,
    Math.floor((expiresAt.getTime() - Date.now()) / 1000),
  );
  setCookie(c, "ha_session", newToken, sessionCookieAttrs(remainingMaxAge));

  return c.json({ success: true });
});

// Truthful session probe: only reachable with a valid, unexpired session
// cookie (this router is mounted before the global auth middleware, so the
// check is applied per-route). Used by the frontend's session bootstrap.
authRouter.get("/sessions", authMiddleware, async (c) => {
  return c.json({ active: true });
});
