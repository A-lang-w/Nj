import { describe, expect, it, vi } from "vitest";
import { join } from "node:path";

import { observed } from "../../../tests/fixtures/analysisExecution.js";
import {
  createBinarySessionTargets,
  createTestBinaryTargetRegistry,
  WedgedAnalysisClient,
} from "../../../tests/fixtures/binarySession.js";
import { ok as resultOk } from "../../domain/result.js";
import type { AnalysisClient } from "../AnalysisProvider.js";

/** A provider that answers at once, including the reads that need no provider. */
const healthyClient = (): AnalysisClient => ({
  execute: () => Promise.resolve(observed(null)),
  executeIfReady: (operation) => Promise.resolve(observed(operation)),
  close: () => Promise.resolve(resultOk(null)),
});

/**
 * A replacement releases a background start that ignored its abort.
 *
 * The start holds the session transition, and the ordinary open serializes
 * behind it. The job stays registered until its start stopped, so the
 * replacement takes the bounded wait and the forced close instead of waiting
 * for a start that will never finish.
 */
describe("a replacement that follows a background start that ignored its abort", () => {
  it("replaces the wedged target instead of waiting for it", async () => {
    const [first, second] = await createBinarySessionTargets();
    let clients = 0;
    const registry = createTestBinaryTargetRegistry(
      () => {
        clients += 1;
        return clients === 1 ? new WedgedAnalysisClient() : healthyClient();
      },
      {},
      { jobSettleTimeoutMs: 50 },
    );

    // The background import starts a provider that never unwinds.
    expect(
      (await registry.open(first, { analysisMode: "background" })).ok,
    ).toBe(true);
    await vi.waitFor(() => expect(clients).toBe(1));

    // The replacement must not queue behind the wedged start.
    const replaced = await registry.open(second);
    expect(replaced.ok).toBe(true);
    expect(registry.activeTarget()?.path).toBe(second);
    // The forced close released the client of the wedged start.
    expect(clients).toBe(2);
  });

  it("replaces a wedged background job with a background job of its own", async () => {
    const [first, second] = await createBinarySessionTargets();
    let clients = 0;
    const registry = createTestBinaryTargetRegistry(
      () => {
        clients += 1;
        return clients === 1 ? new WedgedAnalysisClient() : healthyClient();
      },
      {},
      { jobSettleTimeoutMs: 50 },
    );

    // The background import starts a provider that never unwinds.
    expect(
      (await registry.open(first, { analysisMode: "background" })).ok,
    ).toBe(true);
    await vi.waitFor(() => expect(clients).toBe(1));

    // The background replacement must not queue behind the wedged start.
    const replaced = await registry.open(second, {
      analysisMode: "background",
    });
    expect(replaced.ok).toBe(true);
    expect(registry.activeTarget()?.path).toBe(second);
    // The forced close released the client of the wedged start.
    await vi.waitFor(() => expect(clients).toBe(2));
  });

  /**
   * Two replacements that cancel the same wedged job.
   *
   * The cancellation of a job belongs to that job, so both replacements wait
   * for the same one. The second replacement must not force-close the slot
   * again: the first replacement opened its own target there, and that
   * analysis is not the wedged start the second replacement meant to release.
   */
  it("keeps the analysis the first replacement opened", async () => {
    const [first, second] = await createBinarySessionTargets();
    const missing = join(first, "missing.hop");
    let clients = 0;
    let closes = 0;
    const registry = createTestBinaryTargetRegistry(
      () => {
        clients += 1;
        // Only the first start wedges. A later start answers at once.
        const wedged = clients === 1;
        return {
          execute: () =>
            wedged
              ? new Promise<ReturnType<typeof observed>>(() => undefined)
              : Promise.resolve(observed(null)),
          close: () => {
            closes += 1;
            return Promise.resolve(resultOk(null));
          },
        };
      },
      {},
      { jobSettleTimeoutMs: 200 },
    );

    // The background import starts a provider that never unwinds.
    expect(
      (await registry.open(first, { analysisMode: "background" })).ok,
    ).toBe(true);
    await vi.waitFor(() => expect(clients).toBe(1));

    // The first replacement takes the forced close and opens its own target.
    const replacing = registry.open(second);
    // The second replacement cancels the same job, less than a settle bound
    // later, so its own wait expires after the first replacement opened.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const failing = registry.open(missing);

    expect((await replacing).ok).toBe(true);
    // The second replacement cannot open a target that does not exist.
    expect((await failing).ok).toBe(false);
    // The stale cancellation left the analysis the first replacement opened
    // alone, and only the wedged provider was released.
    expect(registry.activeTarget()?.path).toBe(second);
    expect(closes).toBe(1);
  });

  it("closes every target when a background start ignores its abort", async () => {
    const [first, second] = await createBinarySessionTargets();
    let clients = 0;
    const registry = createTestBinaryTargetRegistry(
      () => {
        clients += 1;
        return clients === 1 ? new WedgedAnalysisClient() : healthyClient();
      },
      {},
      { jobSettleTimeoutMs: 50 },
    );

    expect(
      (await registry.open(first, { analysisMode: "background" })).ok,
    ).toBe(true);
    await vi.waitFor(() => expect(clients).toBe(1));
    expect((await registry.open(second, { keepOthersOpen: true })).ok).toBe(
      true,
    );

    // The shutdown must not wait for a start that will never finish.
    const closed = await registry.closeAll();
    expect(closed.ok).toBe(true);
    expect(registry.targets()).toHaveLength(0);
  });
});
