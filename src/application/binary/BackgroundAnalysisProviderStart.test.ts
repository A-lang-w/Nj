import { describe, expect, it, vi } from "vitest";

import { ok as resultOk } from "../../domain/result.js";
import { observed } from "../../../tests/fixtures/analysisExecution.js";
import {
  createBinarySessionTargets,
  createDeferred,
  createTestComposedBinaryTargetRegistry,
} from "../../../tests/fixtures/binarySession.js";

/**
 * The production route is a composite: a deep provider plus auxiliary
 * providers. Its health probe answers without touching a child, so an open
 * that reports the target as started has to start the provider it selected
 * itself. Otherwise the background job reports a ready target that no
 * provider ever started, and the start happens later on the first analysis
 * call, outside the job's start limit and wait budget.
 */
describe("a background analysis job on a composed route", () => {
  it("starts the provider the route selected inside the job", async () => {
    const [first] = await createBinarySessionTargets();
    const health = createDeferred<ReturnType<typeof observed>>();
    let deepClients = 0;
    let deepStarts = 0;
    let auxiliaryClients = 0;
    const registry = createTestComposedBinaryTargetRegistry(
      () => {
        deepClients += 1;
        return {
          execute: (operation: string) => {
            if (operation !== "health") return Promise.resolve(observed(null));
            deepStarts += 1;
            return health.promise;
          },
          close: () => Promise.resolve(resultOk(null)),
        };
      },
      {},
      {},
      () => {
        auxiliaryClients += 1;
        return {
          execute: () => Promise.resolve(observed(null)),
          close: () => Promise.resolve(resultOk(null)),
        };
      },
    );

    const opened = await registry.open(first, { analysisMode: "background" });
    expect(opened.ok).toBe(true);

    // The job started the provider it selected, and the job is still
    // starting while that provider starts.
    await vi.waitFor(() => expect(deepStarts).toBe(1));
    expect(deepClients).toBe(1);
    expect(registry.analysisState()).toMatchObject({ state: "starting" });

    // The auxiliary provider stays lazy: only the selected provider starts.
    expect(auxiliaryClients).toBe(0);

    health.resolve(observed(null));
    await vi.waitFor(() =>
      expect(registry.analysisState()).toMatchObject({ state: "ready" }),
    );
  });
});
