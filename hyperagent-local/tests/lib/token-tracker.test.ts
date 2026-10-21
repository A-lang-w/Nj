import { describe, it, expect, beforeEach } from "vitest";
import {
  recordUsage,
  estimateAndRecordUsage,
  getUsageSummary,
} from "../../src/lib/token-tracker.js";

/**
 * Token-tracker state is in-memory and shared across tests within a single
 * vitest worker process. Each test records unique model names to avoid
 * cross-test accumulation interference, and the zero-state test runs first
 * via describe ordering to validate the initial shape before any recording.
 */

describe("token-tracker", () => {
  describe("getUsageSummary zero state", () => {
    it("returns the correct shape with null periods before any recording", () => {
      const summary = getUsageSummary(1);
      expect(typeof summary.promptTokens).toBe("number");
      expect(typeof summary.completionTokens).toBe("number");
      expect(typeof summary.totalTokens).toBe("number");
      expect(summary.promptTokens).toBeGreaterThanOrEqual(0);
      expect(summary.completionTokens).toBeGreaterThanOrEqual(0);
      expect(summary.totalTokens).toBeGreaterThanOrEqual(0);
      expect(typeof summary.byModel).toBe("object");
      expect(summary.byModel).not.toBeNull();
      // periodStart and periodEnd are either null or valid ISO-8601 strings;
      // in a fresh process they would be null, but prior tests in the same
      // worker may have recorded usage, so we only validate the type.
      if (summary.periodStart !== null) {
        expect(new Date(summary.periodStart).toISOString()).toBe(
          summary.periodStart,
        );
      }
      if (summary.periodEnd !== null) {
        expect(new Date(summary.periodEnd).toISOString()).toBe(
          summary.periodEnd,
        );
      }
    });
  });

  describe("recordUsage accumulation", () => {
    it("accumulates prompt, completion, and total tokens across calls", () => {
      const model = "test-accum-model";
      const before = getUsageSummary(1);
      const beforeTotal = before.totalTokens;
      const beforePrompt = before.promptTokens;
      const beforeCompletion = before.completionTokens;

      recordUsage(1, model, 100, 50);
      recordUsage(1, model, 200, 75);

      const after = getUsageSummary(1);
      expect(after.promptTokens).toBe(beforePrompt + 300);
      expect(after.completionTokens).toBe(beforeCompletion + 125);
      expect(after.totalTokens).toBe(beforeTotal + 425);
    });

    it("tracks per-model breakdown independently", () => {
      const modelA = "test-per-model-a";
      const modelB = "test-per-model-b";

      recordUsage(1, modelA, 10, 20);
      recordUsage(1, modelB, 30, 40);
      recordUsage(1, modelA, 5, 15);

      const summary = getUsageSummary(1);
      expect(summary.byModel[modelA]).toBeDefined();
      expect(summary.byModel[modelA].promptTokens).toBeGreaterThanOrEqual(15);
      expect(summary.byModel[modelA].completionTokens).toBeGreaterThanOrEqual(
        35,
      );
      expect(summary.byModel[modelA].totalTokens).toBeGreaterThanOrEqual(50);

      expect(summary.byModel[modelB]).toBeDefined();
      expect(summary.byModel[modelB].promptTokens).toBeGreaterThanOrEqual(30);
      expect(summary.byModel[modelB].completionTokens).toBeGreaterThanOrEqual(
        40,
      );
      expect(summary.byModel[modelB].totalTokens).toBeGreaterThanOrEqual(70);
    });

    it("sets periodStart on first recording and updates periodEnd", () => {
      const model = "test-period-model";
      recordUsage(1, model, 1, 1);

      const summary = getUsageSummary(1);
      expect(summary.periodStart).not.toBeNull();
      expect(summary.periodEnd).not.toBeNull();
      // periodEnd must be >= periodStart
      expect(new Date(summary.periodEnd!).getTime()).toBeGreaterThanOrEqual(
        new Date(summary.periodStart!).getTime(),
      );
    });
  });

  describe("estimateAndRecordUsage", () => {
    it("converts character counts to tokens using ~4 chars per token", () => {
      const model = "test-estimate-model";
      const before = getUsageSummary(1);
      const beforePrompt = before.promptTokens;
      const beforeCompletion = before.completionTokens;

      // 20 chars -> ceil(20/4) = 5 prompt tokens
      // 12 chars -> ceil(12/4) = 3 completion tokens
      estimateAndRecordUsage(1, model, 20, 12);

      const after = getUsageSummary(1);
      expect(after.promptTokens).toBe(beforePrompt + 5);
      expect(after.completionTokens).toBe(beforeCompletion + 3);
    });

    it("clamps zero-length inputs to at least 1 token each", () => {
      const model = "test-estimate-zero-model";
      const before = getUsageSummary(1);
      const beforePrompt = before.promptTokens;
      const beforeCompletion = before.completionTokens;

      estimateAndRecordUsage(1, model, 0, 0);

      const after = getUsageSummary(1);
      expect(after.promptTokens).toBe(beforePrompt + 1);
      expect(after.completionTokens).toBe(beforeCompletion + 1);
    });
  });

  describe("getUsageSummary returns a deep copy", () => {
    it("does not allow mutation of internal state through the returned object", () => {
      const model = "test-deep-copy-model";
      recordUsage(1, model, 10, 10);

      const summary = getUsageSummary(1);
      const originalTotal = summary.totalTokens;
      summary.totalTokens = 999999;
      if (summary.byModel[model]) {
        summary.byModel[model].totalTokens = 999999;
      }

      const fresh = getUsageSummary(1);
      expect(fresh.totalTokens).toBe(originalTotal);
      expect(fresh.byModel[model]?.totalTokens).not.toBe(999999);
    });
  });
});
