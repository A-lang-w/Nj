import { Hono } from "hono";
import { authMiddleware } from "../auth/middleware.js";
import { getUsageSummary } from "../lib/token-tracker.js";

export const integrationsRouter = new Hono();

integrationsRouter.use("/*", authMiddleware);

// Local-mode stub: no integration profiles exist in local deployments.
// Returns stub/localMode markers so the frontend can detect local mode.
integrationsRouter.get("/profiles", async (c) => {
  return c.json({ stub: true, localMode: true, profiles: [] });
});

// Local-mode billing status: plan is always "local"; cycle bounds come from
// the in-process token tracker (stub:false so the UI can show live usage).
integrationsRouter.get("/settings/billing/status", async (c) => {
  const usage = getUsageSummary(c.get("auth").userId);
  return c.json({
    stub: false,
    localMode: true,
    plan: "local",
    status: "active",
    billingCycleStart: usage.periodStart,
    billingCycleEnd: usage.periodEnd,
  });
});

// Local-mode token consumption from the in-process tracker (per-user).
integrationsRouter.get("/settings/billing/consumption", async (c) => {
  const usage = getUsageSummary(c.get("auth").userId);
  return c.json({
    stub: false,
    localMode: true,
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    totalTokens: usage.totalTokens,
    byModel: usage.byModel,
    periodStart: usage.periodStart,
    periodEnd: usage.periodEnd,
  });
});

// Local-mode stub: credit notices are not applicable in local mode.
// Returns stub/localMode markers so the frontend can detect local mode.
integrationsRouter.get("/settings/billing/credit-notice", async (c) => {
  return c.json({ stub: true, localMode: true, message: null });
});

// Local-mode stub: referral system is not available in local mode.
// Returns stub/localMode markers so the frontend can detect local mode.
integrationsRouter.get("/referrals", async (c) => {
  return c.json({
    stub: true,
    localMode: true,
    code: null,
    referrals: [],
    rewardAmount: 0,
  });
});

// Local-mode stub: client metrics are not sent in local mode.
// Accepts the request as a no-op to prevent client-side errors.
integrationsRouter.post("/metrics/client", async (c) => {
  return c.json({ stub: true, localMode: true, accepted: true });
});

// Local-mode stub: client logs are not persisted in local mode.
// Accepts the request as a no-op to prevent client-side errors.
integrationsRouter.post("/logs/client", async (c) => {
  return c.json({ stub: true, localMode: true, accepted: true });
});

// Local-mode stub: activity tracking is not available in local mode.
// Accepts the request as a no-op to prevent client-side errors.
integrationsRouter.post("/activity", async (c) => {
  return c.json({ stub: true, localMode: true, accepted: true });
});

// Local-mode stub: funnel analytics are not tracked in local mode.
// Accepts the request as a no-op to prevent client-side errors.
integrationsRouter.post("/funnel", async (c) => {
  return c.json({ stub: true, localMode: true, accepted: true });
});
