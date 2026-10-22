import { describe, expect, it, vi } from "vitest";

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
