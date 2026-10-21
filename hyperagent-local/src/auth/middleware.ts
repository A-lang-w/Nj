import type { Context, Next } from "hono";
import { getCookie } from "hono/cookie";
import { eq, and } from "drizzle-orm";
import { verifyToken } from "./tokens.js";
import { db } from "../db/connection.js";
import { sessions } from "../db/schema.js";
import { config } from "../config.js";
import { logger } from "../lib/logger.js";

export interface AuthContext {
  userId: number;
  email: string;
}

declare module "hono" {
  interface ContextVariableMap {
    auth: AuthContext;
  }
}

export async function authMiddleware(c: Context, next: Next) {
  const token = getCookie(c, "ha_session");
  if (!token) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const payload = await verifyToken(token);
  if (!payload) {
    return c.json({ error: "Invalid session" }, 401);
  }

  // Verify that an active, non-expired session exists for this user AND
  // that the token's jti matches the session's current jti. This ensures
  // rotated tokens are rejected: after a refresh, the old session row
  // (and its jti) is deleted, so any replay of the pre-rotation token
  // fails here even though the JWT signature is still valid.
  const activeSession = db
    .select()
    .from(sessions)
    .where(
      and(eq(sessions.userId, payload.userId), eq(sessions.jti, payload.jti)),
    )
    .get();

  if (!activeSession) {
    return c.json({ error: "Session expired or revoked" }, 401);
  }

  // Clock-skew-resistant expiry check: allow a bounded tolerance window so
  // minor wall-clock drift does not prematurely invalidate sessions.
  // Sessions are treated as expired only when expiresAt falls below
  // Date.now() minus this window. The tolerance comes pre-validated from
  // config (garbage env falls back to the default, never NaN-fail-open).
  const nowMs = Date.now();
  const expiresAtMs = activeSession.expiresAt.getTime();
  const effectiveNowMs = nowMs - config.sessionSkewToleranceMs;

  if (expiresAtMs < effectiveNowMs) {
    return c.json({ error: "Session expired or revoked" }, 401);
  }

  // Past wall-clock expiry but still inside the tolerance window: warn once
  // the past-expiry amount exceeds the log threshold so operators can catch
  // NTP/host-clock drift without failing legitimate requests. The threshold
  // must be below the tolerance window or this branch is unreachable.
  if (expiresAtMs < nowMs) {
    const pastExpiryMs = nowMs - expiresAtMs;
    if (pastExpiryMs > config.sessionSkewLogThresholdMs) {
      logger.warn("Session within skew tolerance but past wall-clock expiry", {
        sessionId: activeSession.id,
        userId: payload.userId,
        expiresAt: activeSession.expiresAt.toISOString(),
        now: new Date(nowMs).toISOString(),
        pastExpiryMs,
      });
    }
  }

  c.set("auth", payload);
  await next();
}
