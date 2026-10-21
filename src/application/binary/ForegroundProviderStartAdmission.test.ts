import { describe, expect, it, vi } from "vitest";

import { ok as resultOk } from "../../domain/result.js";
import { observed } from "../../../tests/fixtures/analysisExecution.js";
import {
  createBinarySessionTargets,
  createDeferred,
  createTestComposedBinaryTargetRegistry,
} from "../../../tests/fixtures/binarySession.js";

/**
 * The production route is a composite, so the provider it selected starts
 * with the first call that needs it rather than with the open. The shared
 * start limit covers that deferred start, so the import that follows has to
 * run under it: without that, two foreground targets start two imports
 * beside each other.
 */
describe("a foreground open on a composed route", () => {
  it("starts the provider under the shared start limit", async () => {
    const [first, second] = await createBinarySessionTargets();
    const starts: Array<
      ReturnType<typeof createDeferred<ReturnType<typeof observed>>>
    > = [];
    let calls = 0;
    const registry = createTestComposedBinaryTargetRegistry(
      () => {
        const start = createDeferred<ReturnType<typeof observed>>();
        starts.push(start);
        return {
          execute: (operation: string) => {
            if (operation === "health") return Promise.resolve(observed(null));
            calls += 1;
            return start.promise;
          },
          close: () => Promise.resolve(resultOk(null)),
        };
      },
      {},
      { maxConcurrentAnalyses: 1 },
    );

    const openedFirst = await registry.open(first, { keepOthersOpen: true });
    const openedSecond = await registry.open(second, { keepOthersOpen: true });
    expect(openedFirst.ok).toBe(true);
    expect(openedSecond.ok).toBe(true);
    // The open resolves the target; the provider starts with the first call
    // that needs it.
    expect(calls).toBe(0);

    const handleFor = (path: string): string => {
      const handle = registry
        .targets()
        .find(({ target }) => target.path === path)?.target_id;
      if (handle === undefined) throw new Error("expected an open target");
      return handle;
    };

    const firstCall = registry.execute(
      "address_name",
      {},
      { targetId: handleFor(first) },
    );
    const secondCall = registry.execute(
      "address_name",
      {},
      { targetId: handleFor(second) },
    );

    await vi.waitFor(() => expect(calls).toBe(1));
    // The second provider waits for the first one: the limit covers the
    // import the composed client defers to the first call.
    expect(calls).toBe(1);

    starts[0]?.resolve(observed(null));
    await expect(firstCall).resolves.toMatchObject({ ok: true });
    await vi.waitFor(() => expect(calls).toBe(2));

    starts[1]?.resolve(observed(null));
    await expect(secondCall).resolves.toMatchObject({ ok: true });
  });
});

/**
 * The start permit is taken around the provider start, not around the open
 * that waits for the calls that ran before it.
 *
 * A reopen waits for the calls of the slot it opens. A call that waits for
 * the start permit waits for the reopen when the reopen holds that permit,
 * and the reopen waits for that call: the two would wait for each other
 * forever, and every later start would stay queued behind them.
 */
describe("a reopen that waits for an earlier call", () => {
  it("does not hold the start permit the earlier call waits for", async () => {
    const [first] = await createBinarySessionTargets();
    const starts: Array<
      ReturnType<typeof createDeferred<ReturnType<typeof observed>>>
    > = [];
    let calls = 0;
    const registry = createTestComposedBinaryTargetRegistry(
      () => {
        const start = createDeferred<ReturnType<typeof observed>>();
        starts.push(start);
        return {
          execute: (operation: string) => {
            if (operation === "health") return Promise.resolve(observed(null));
            calls += 1;
            return start.promise;
          },
          close: () => Promise.resolve(resultOk(null)),
        };
      },
      {},
      { maxConcurrentAnalyses: 1 },
    );

    const opened = await registry.open(first, { keepOthersOpen: true });
    expect(opened.ok).toBe(true);
    const handle = registry.targets()[0]?.target_id;
    if (handle === undefined) throw new Error("expected an open target");

    // The call needs the provider, so it waits for the start permit.
    const call = registry.execute("address_name", {}, { targetId: handle });
    // The reopen waits for the call that ran before it.
    const reopening = registry.open(first, { keepOthersOpen: true });

    // The call reaches the provider start: the reopen does not hold the start
    // permit while it waits for that call.
    await vi.waitFor(() => expect(calls).toBe(1));

    starts[0]?.resolve(observed(null));
    await expect(call).resolves.toMatchObject({ ok: true });
    await expect(reopening).resolves.toMatchObject({ ok: true });
  });
});
