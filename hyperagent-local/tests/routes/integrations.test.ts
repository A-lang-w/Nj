import { describe, it, expect, beforeAll } from "vitest";
import { Hono } from "hono";
import { db } from "../../src/db/connection.js";
import { sessions } from "../../src/db/schema.js";
import { signToken } from "../../src/auth/tokens.js";
import { integrationsRouter } from "../../src/routes/integrations.js";
import { handleAppError } from "../../src/lib/error-handler.js";

function buildApp() {
  const app = new Hono();
  app.onError(handleAppError);
  app.route("/integrations", integrationsRouter);
  return app;
}

let cookie = "";
const app = buildApp();

beforeAll(async () => {
  const jti = "integrations-test-jti-001";
  await db.insert(sessions).values({
    id: "integrations-test-session-001",
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

describe("integrations route local-mode stubs", () => {
  it("returns stub profiles in local mode", async () => {
    const res = await authed("/integrations/profiles");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.stub).toBe(true);
    expect(body.localMode).toBe(true);
    expect(Array.isArray(body.profiles)).toBe(true);
  });

  it("returns 404 for removed slack oauth status endpoint", async () => {
    // The Slack OAuth endpoint was intentionally removed; this asserts the
    // route no longer exists without assuming a JSON response body.
    const res = await authed("/integrations/slack/oauth/status");
    expect(res.status).toBe(404);
  });

  it("returns live billing status with usage period in local mode", async () => {
    const res = await authed("/integrations/settings/billing/status");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.stub).toBe(false);
    expect(body.localMode).toBe(true);
    expect(body.plan).toBe("local");
    expect(body.status).toBe("active");
    // billingCycleStart/End are null when no usage has been recorded, or
    // valid ISO-8601 strings after token-tracker accumulates data.
    if (body.billingCycleStart !== null) {
      expect(new Date(body.billingCycleStart).toISOString()).toBe(
        body.billingCycleStart,
      );
    }
    if (body.billingCycleEnd !== null) {
      expect(new Date(body.billingCycleEnd).toISOString()).toBe(
        body.billingCycleEnd,
      );
    }
  });

  it("returns live billing consumption with token breakdown in local mode", async () => {
    const res = await authed("/integrations/settings/billing/consumption");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.stub).toBe(false);
    expect(body.localMode).toBe(true);
    expect(typeof body.promptTokens).toBe("number");
    expect(body.promptTokens).toBeGreaterThanOrEqual(0);
    expect(typeof body.completionTokens).toBe("number");
    expect(body.completionTokens).toBeGreaterThanOrEqual(0);
    expect(typeof body.totalTokens).toBe("number");
    expect(body.totalTokens).toBeGreaterThanOrEqual(0);
    expect(typeof body.byModel).toBe("object");
    expect(body.byModel).not.toBeNull();
    // periodStart/periodEnd are null when no usage has been recorded, or
    // valid ISO-8601 strings after token-tracker accumulates data.
    if (body.periodStart !== null) {
      expect(new Date(body.periodStart).toISOString()).toBe(body.periodStart);
    }
    if (body.periodEnd !== null) {
      expect(new Date(body.periodEnd).toISOString()).toBe(body.periodEnd);
    }
  });

  it("returns credit notice stub in local mode", async () => {
    const res = await authed("/integrations/settings/billing/credit-notice");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.stub).toBe(true);
    expect(body.message).toBeNull();
  });

  it("returns referrals stub in local mode", async () => {
    const res = await authed("/integrations/referrals");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.stub).toBe(true);
    expect(body.code).toBeNull();
    expect(Array.isArray(body.referrals)).toBe(true);
  });

  it("accepts client metrics post as no-op", async () => {
    const res = await authed("/integrations/metrics/client", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event: "page_view" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.accepted).toBe(true);
  });

  it("accepts client logs post as no-op", async () => {
    const res = await authed("/integrations/logs/client", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ level: "info", message: "test" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.accepted).toBe(true);
  });

  it("accepts activity post as no-op stub", async () => {
    const res = await authed("/integrations/activity", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "click" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ stub: true, localMode: true, accepted: true });
  });

  it("accepts funnel post as no-op", async () => {
    const res = await authed("/integrations/funnel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ step: "signup" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.accepted).toBe(true);
  });

  it("rejects unauthenticated access to profiles", async () => {
    const res = await app.request("/integrations/profiles");
    expect(res.status).toBe(401);
  });

  it("rejects unauthenticated access to billing status", async () => {
    const res = await app.request("/integrations/settings/billing/status");
    expect(res.status).toBe(401);
  });
});
