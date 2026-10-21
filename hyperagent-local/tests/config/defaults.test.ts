import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

describe("config defaults", () => {
  it("falls back to local-first defaults when env is unset", async () => {
    // setup-env sets JWT_SECRET (required) and DATA_DIR (isolation); clear
    // the documented-default keys so the import below observes bare env.
    // (RESIDENCY_STRICT is pinned false by setup-env, so its default-true
    // is asserted by code inspection, not here.)
    for (const key of [
      "LLM_BASE_URL",
      "LLM_API_KEY",
      "LLM_MODEL",
      "DATA_DIR",
      "PORT",
      "HOST",
    ]) {
      delete process.env[key];
    }
    const { config } = await import("../../src/config.js");
    expect(config.llmBaseUrl).toBe("http://localhost:11434/v1");
    expect(config.llmApiKey).toBe("ollama");
    expect(config.llmModel).toBe("claude-opus-5-5");
    expect(config.dataDir).toBe("./data");
    expect(config.port).toBe(3000);
    expect(config.host).toBe("127.0.0.1");
  });

  it("never shells out DATA_DIR during mount verification", async () => {
    // A hostile DATA_DIR must not execute: the df probe takes it as a
    // plain argv entry (no shell), so the embedded touch never runs. The
    // directory pre-exists, forcing verification down to the df branch
    // instead of throwing earlier at mkdir. Dynamic import: a static one
    // would cache config before the defaults test clears its env keys.
    const { verifyDataResidency } = await import("../../src/config.js");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hal-res-"));
    const canary = path.join(dir, "PWNED");
    const hostile = path.join(dir, 'x"; touch "PWNED"; echo "');
    fs.mkdirSync(hostile);
    verifyDataResidency({ dataDir: hostile, residencyStrict: true });
    expect(fs.existsSync(canary)).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("falls back to default skew windows on garbage env (never NaN-fail-open)", async () => {
    // Unvalidated Number(env) would yield NaN, and every expiry comparison
    // against NaN is false — sessions would never expire. vi.resetModules
    // forces a fresh config import that observes the garbage values below.
    const savedTolerance = process.env.SESSION_SKEW_TOLERANCE_MS;
    const savedThreshold = process.env.SESSION_SKEW_LOG_THRESHOLD_MS;
    try {
      process.env.SESSION_SKEW_TOLERANCE_MS = "not-a-number";
      process.env.SESSION_SKEW_LOG_THRESHOLD_MS = "-5";
      vi.resetModules();
      const { config: garbage } = await import("../../src/config.js");
      expect(garbage.sessionSkewToleranceMs).toBe(60_000);
      expect(garbage.sessionSkewLogThresholdMs).toBe(10_000);

      process.env.SESSION_SKEW_TOLERANCE_MS = "120000";
      process.env.SESSION_SKEW_LOG_THRESHOLD_MS = "0";
      vi.resetModules();
      const { config: valid } = await import("../../src/config.js");
      expect(valid.sessionSkewToleranceMs).toBe(120_000);
      expect(valid.sessionSkewLogThresholdMs).toBe(0);
    } finally {
      if (savedTolerance === undefined)
        delete process.env.SESSION_SKEW_TOLERANCE_MS;
      else process.env.SESSION_SKEW_TOLERANCE_MS = savedTolerance;
      if (savedThreshold === undefined)
        delete process.env.SESSION_SKEW_LOG_THRESHOLD_MS;
      else process.env.SESSION_SKEW_LOG_THRESHOLD_MS = savedThreshold;
      vi.resetModules();
    }
  });
});
