import type { Context, Next } from "hono";
import { createRateLimiter } from "./rate-limiter.js";
import { resolveClientIp } from "./client-ip.js";

const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute

/**
 * Global rate-limit middleware (SEC-006). Auth routes share a strict
 * per-IP budget; everything else shares a generous one.
 *
 * `/api/auth/login` and `/api/auth/refresh` bypass the shared auth bucket
 * and fall into the general one: they own dedicated limiters with distinct
 * keys and messages (per-IP for login, per-user for refresh). Counting them
 * against the shared 5/min budget as well would let a login burst 429
 * unrelated session probes and refreshes.
 *
 * `/api/auth/sessions` also uses the general bucket: React StrictMode and
 * remounts probe it on every load. A 5/min shared auth budget 429s the
 * bootstrap probe and looks like a signed-out session after a hard refresh.
 */
export function createRateLimitMiddleware() {
  const generalRateLimiter = createRateLimiter({
    windowMs: RATE_LIMIT_WINDOW_MS,
    maxAttempts: 100,
  });
  const authRateLimiter = createRateLimiter({
    windowMs: RATE_LIMIT_WINDOW_MS,
    maxAttempts: 5,
  });

  return async function rateLimitMiddleware(
    c: Context,
    next: Next,
  ): Promise<Response | void> {
    const path = c.req.path;
    const hasDedicatedLimiter =
      path === "/api/auth/login" || path === "/api/auth/refresh";
    const isSessionProbe = path === "/api/auth/sessions";
    const isAuth =
      path.startsWith("/api/auth") && !hasDedicatedLimiter && !isSessionProbe;
    const limiter = isAuth ? authRateLimiter : generalRateLimiter;
    const key = `${resolveClientIp(c)}:${isAuth ? "auth" : "general"}`;

    if (!limiter.check(key)) {
      return c.json({ error: "Too Many Requests" }, 429);
    }

    await next();
  };
}
