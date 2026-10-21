import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { authRouter } from "../../src/routes/auth.js";
import { handleAppError } from "../../src/lib/error-handler.js";

// Separate file from contracts.test.ts: the login rate limiter is module
// state (5/min per IP), and contracts already spends 4 of its 5 logins.
// Vitest isolates modules per file, so this file gets a fresh limiter.
// Runs against the isolated per-file database from tests/setup-env.ts.
describe("login race", () => {
  it("converges parallel fresh-email logins on one user instead of 500ing", async () => {
    const app = new Hono();
    app.onError(handleAppError);
    app.route("/auth", authRouter);
    const login = () =>
      app.request("/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "race-winner@example.com" }),
      });
    // Both selects miss before either insert lands; pre-fix the loser hit
    // unique(email) and returned 500.
    const [a, b] = await Promise.all([login(), login()]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const [aBody, bBody] = (await Promise.all([a.json(), b.json()])) as Array<{
      user: { id: number };
    }>;
    expect(aBody.user.id).toBe(bBody.user.id);
  });

  it("returns 400 (not 500) for JSON null and array login bodies", async () => {
    const app = new Hono();
    app.onError(handleAppError);
    app.route("/auth", authRouter);
    for (const body of ["null", "[]", '"just-a-string"']) {
      const res = await app.request("/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: "Request body must be an object",
      });
    }
  });
});
