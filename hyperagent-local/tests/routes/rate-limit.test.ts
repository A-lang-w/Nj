import { describe, it, expect, beforeAll } from "vitest";
import { Hono } from "hono";
import { db } from "../../src/db/connection.js";
import { sessions } from "../../src/db/schema.js";
import { signToken } from "../../src/auth/tokens.js";
import { authRouter } from "../../src/routes/auth.js";
import { createRateLimitMiddleware } from "../../src/lib/rate-limit-middleware.js";

// Limiter-interaction tests: the global middleware and the route-level auth
// limiters must compose so one burst class cannot starve the others.
function buildApp() {
  const app = new Hono();
  app.use("*", createRateLimitMiddleware());
  app.route("/api/auth", authRouter);
  return app;
}

let cookie = "";
const app = buildApp();

beforeAll(async () => {
  const jti = "ratelimit-test-jti-001";
  await db.insert(sessions).values({
    id: "ratelimit-test-session-001",
    userId: 1,
    jti,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
  });
  const token = await signToken({ userId: 1, email: "test@test.com" }, jti);
  cookie = `ha_session=${token}`;
});

describe("rate limiter interaction", () => {
  it("login bursts do not exhaust the session-probe budget", async () => {
    // Five logins fill the dedicated per-IP login limiter; the shared auth
    // bucket must be untouched by them.
    for (let i = 0; i < 5; i++) {
      const res = await app.request("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: `burst${i}@local.test` }),
      });
      expect(res.status).toBe(200);
    }

    const probe = await app.request("/api/auth/sessions", {
      headers: { Cookie: cookie },
    });
    expect(probe.status).toBe(200);

    // The dedicated login limiter still guards: a sixth login 429s with
    // its own message, not the global one.
    const sixth = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "burst5@local.test" }),
    });
    expect(sixth.status).toBe(429);
    expect(await sixth.json()).toEqual({
      error: "Too many login attempts. Please wait before trying again.",
    });
  });
});
