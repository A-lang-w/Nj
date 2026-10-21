import { describe, expect, it, vi } from "vitest";

import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { ok as resultOk, err } from "../../domain/result.js";
import { HopperStartError } from "../../domain/hopperErrors.js";
import { ProviderCleanupError } from "../../domain/providerCleanupError.js";
import { AnalysisCancelledError } from "../../domain/analysisErrorCore.js";
import { observed } from "../../../tests/fixtures/analysisExecution.js";
import {
  createBinarySessionTargets,
  createDeferred,
  createTestBinarySession,
  createTestBinaryTargetRegistry,
  createTestComposedBinarySession,
  createTestComposedBinaryTargetRegistry,
} from "../../../tests/fixtures/binarySession.js";
import type { ProviderStartAdmission } from "../AnalysisProvider.js";

/** Write one more target beside the targets the fixture created. */
const createTarget = async (beside: string, name: string): Promise<string> => {
  const path = join(dirname(beside), `${name}.hop`);
  await writeFile(path, name);
  return path;
};

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

/**
 * An open that cannot start still owns a client it created and a target it
 * replaced.
 *
 * The admission reports the failure it could not acquire a permit for. The
 * cleanup of that failed open releases the client and restores the target, so
 * a cancelled open does not lose the target it replaced and does not leave the
 * client it created running.
 */
describe("an open whose start admission reports a failure", () => {
  it("releases the client it created and restores the target it replaced", async () => {
    const [first, second] = await createBinarySessionTargets();
    let clients = 0;
    let closes = 0;
    const session = createTestBinarySession(() => {
      clients += 1;
      return {
        execute: () => Promise.resolve(observed(null)),
        close: () => {
          closes += 1;
          return Promise.resolve(resultOk(null));
        },
      };
    });

    expect((await session.open(first)).ok).toBe(true);

    // The admission reports the failure it could not acquire a permit for
    // without running the cleanup of the failed open.
    const admission: ProviderStartAdmission = {
      run: async () => err(new AnalysisCancelledError("open_binary")),
    };

    const cancelled = await session.open(second, { startAdmission: admission });
    expect(cancelled.ok).toBe(false);
    if (cancelled.ok) return;
    expect(cancelled.error).toBeInstanceOf(AnalysisCancelledError);

    // The client the cancelled open created is released, and the target it
    // replaced is restored.
    expect(closes).toBe(2);
    expect(clients).toBe(3);
    expect(session.activeTarget()?.path).toBe(first);
  });
});

/**
 * A restored target starts its provider under the shared start limit.
 *
 * A failed open restores the target it replaced, and the restored client
 * defers the provider start to the first call that needs it. The restored
 * client therefore carries the admission that bounds that start: a restored
 * target that starts its provider without it runs beside a provider that is
 * still starting, and the analysis cap that bounds the concurrent analyses
 * is exceeded.
 */
describe("a target restored by a failed start", () => {
  it("starts its provider under the admission that bounds the session", async () => {
    const [first, second] = await createBinarySessionTargets();
    let admitted = 0;
    let reportFailure = true;
    const admission: ProviderStartAdmission = {
      run: async (start, _operation, _signal, cleanup) => {
        admitted += 1;
        if (!reportFailure) return start();
        // The limit could not be acquired, so the start never ran and the
        // cleanup of the failed open owns the client it created and the
        // target it replaced.
        reportFailure = false;
        const failure = new AnalysisCancelledError("open_binary");
        if (cleanup === undefined) return err(failure);
        return err((await cleanup(failure)).error);
      },
    };
    const session = createTestComposedBinarySession(() => ({
      execute: () => Promise.resolve(observed(null)),
      close: () => Promise.resolve(resultOk(null)),
    }));

    expect((await session.open(first)).ok).toBe(true);

    const failed = await session.open(second, { startAdmission: admission });
    expect(failed.ok).toBe(false);
    // The target the failed open replaced is restored.
    expect(session.activeTarget()?.path).toBe(first);
    // The restoration does not take a permit of its own, so a cancelled open
    // does not wait for a limit it cannot use.
    expect(admitted).toBe(1);

    // The restored client defers its provider start, so the first call that
    // needs the provider runs under the admission.
    const called = await session.execute("address_name", {});
    expect(called.ok).toBe(true);
    expect(admitted).toBe(2);
  });
});

/**
 * An open that is cancelled while it waits for a start permit owns a client
 * it created.
 *
 * The permit could not be acquired, so the start never ran and the provider
 * was never started. The client the open created is still released, and a
 * client that could not be released keeps counting against the limit until
 * the cleanup that owns it releases it.
 */
describe("an open that is cancelled while it waits for the start permit", () => {
  it("releases the client it created", async () => {
    const [first, second] = await createBinarySessionTargets();
    const third = await createTarget(first, "third");
    const holding = createDeferred<ReturnType<typeof observed>>();
    let clients = 0;
    let closes = 0;
    const registry = createTestBinaryTargetRegistry(
      () => {
        clients += 1;
        const client = clients;
        return {
          execute: () =>
            client === 2 ? holding.promise : Promise.resolve(observed(null)),
          close: () => {
            closes += 1;
            return Promise.resolve(resultOk(null));
          },
        };
      },
      {},
      { maxConcurrentAnalyses: 1 },
    );

    // The first target holds the primary slot.
    expect((await registry.open(first)).ok).toBe(true);

    // The second target starts a provider that never settles, so it holds the
    // start permit.
    const starting = registry.open(second, { keepOthersOpen: true });
    await vi.waitFor(() => expect(clients).toBe(2));

    // The third target waits for that permit and is cancelled while it waits.
    const controller = new AbortController();
    const opening = registry.open(third, {
      keepOthersOpen: true,
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(clients).toBe(3));
    controller.abort();

    const settled = await opening;
    expect(settled.ok).toBe(false);
    if (settled.ok) return;
    expect(settled.error).toBeInstanceOf(AnalysisCancelledError);

    // The client the cancelled open created is released.
    expect(closes).toBe(1);

    holding.resolve(observed(null));
    await starting;
  });

  it("keeps counting a provider it could not release", async () => {
    const [first, second] = await createBinarySessionTargets();
    const third = await createTarget(first, "third");
    const fourth = await createTarget(first, "fourth");
    const holding = createDeferred<ReturnType<typeof observed>>();
    let clients = 0;
    let starts = 0;
    const registry = createTestBinaryTargetRegistry(
      () => {
        clients += 1;
        const client = clients;
        return {
          execute: () => {
            if (client === 2) return holding.promise;
            starts += 1;
            return Promise.resolve(observed(null));
          },
          close: () =>
            Promise.resolve(
              client === 3
                ? err(
                    new ProviderCleanupError("fixture", ["provider-client"], {
                      reason: "the provider could not be released",
                    }),
                  )
                : resultOk(null),
            ),
        };
      },
      {},
      { maxConcurrentAnalyses: 1 },
    );

    expect((await registry.open(first)).ok).toBe(true);
    const starting = registry.open(second, { keepOthersOpen: true });
    await vi.waitFor(() => expect(clients).toBe(2));

    const controller = new AbortController();
    const opening = registry.open(third, {
      keepOthersOpen: true,
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(clients).toBe(3));
    controller.abort();

    const settled = await opening;
    expect(settled.ok).toBe(false);
    if (settled.ok) return;
    expect(settled.error.cleanupIncomplete).toBe(true);

    // The slot that still owns the provider keeps its registration and is
    // reported as retained, so a later close can retry that cleanup.
    const status = (await registry.status()) as Record<string, unknown>;
    expect(status.retained_target_ids as string[]).toHaveLength(1);

    holding.resolve(observed(null));
    await starting;

    // The provider that could not be released keeps counting against the
    // limit, so the next start waits for the cleanup that owns it.
    const later = registry.open(fourth, { keepOthersOpen: true });
    await vi.waitFor(() => expect(clients).toBe(4));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(starts).toBe(1);
    void later;
  });
});

/**
 * A failed start leaves a provider behind, and the cleanup of that failed
 * start owns it.
 *
 * The cleanup runs under the shared start limit, so the limit counts the
 * provider while it may still be running. A cleanup that could not release
 * the provider hands the limit to the retained cleanup, which gives it back
 * when the provider is gone. Without that, the next queued start runs beside
 * a provider that is still alive and the analysis cap is exceeded.
 */
describe("a failed start that could not release its provider", () => {
  it("keeps counting the provider until a later close releases it", async () => {
    const [first, second] = await createBinarySessionTargets();
    let starts = 0;
    let providerReleased = false;
    const registry = createTestBinaryTargetRegistry(
      () => ({
        execute: (operation: string) => {
          // The health probe of a client that starts its provider with its
          // first call is that start.
          if (operation === "health") {
            starts += 1;
            return Promise.resolve(err(new HopperStartError()));
          }
          return Promise.resolve(observed(null));
        },
        close: () =>
          Promise.resolve(
            providerReleased
              ? resultOk(null)
              : err(
                  new ProviderCleanupError("fixture", ["provider-client"], {
                    reason: "the provider could not be released",
                  }),
                ),
          ),
      }),
      {},
      { maxConcurrentAnalyses: 1 },
    );

    const failed = await registry.open(first, { keepOthersOpen: true });
    expect(failed.ok).toBe(false);
    if (failed.ok) return;
    expect(failed.error.cleanupIncomplete).toBe(true);

    // The provider of the failed start may still be running, so the limit
    // counts it and the next start waits for the cleanup that owns it.
    const opening = registry.open(second, { keepOthersOpen: true });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(starts).toBe(1);

    // The slot that still owns the provider keeps its registration and is
    // reported as retained, so a later close can retry that cleanup.
    const status = (await registry.status()) as Record<string, unknown>;
    const retained = status.retained_target_ids as string[];
    expect(retained).toHaveLength(1);

    providerReleased = true;
    const closed = await registry.close({ targetId: retained[0]! });
    expect(closed.ok).toBe(true);

    // The cleanup released the provider, so the limit counts it no more and
    // the queued start runs.
    await vi.waitFor(() => expect(starts).toBe(2));
    await opening;
  });

  it("gives the limit back when the cleanup released the provider", async () => {
    const [first, second] = await createBinarySessionTargets();
    let starts = 0;
    const registry = createTestBinaryTargetRegistry(
      () => ({
        execute: (operation: string) => {
          // The health probe of a client that starts its provider with its
          // first call is that start.
          if (operation === "health") {
            starts += 1;
            return Promise.resolve(err(new HopperStartError()));
          }
          return Promise.resolve(observed(null));
        },
        close: () => Promise.resolve(resultOk(null)),
      }),
      {},
      { maxConcurrentAnalyses: 1 },
    );

    const failed = await registry.open(first, { keepOthersOpen: true });
    expect(failed.ok).toBe(false);

    // The cleanup released the provider, so the failed start holds no limit
    // and the next start runs without waiting.
    const opening = registry.open(second, { keepOthersOpen: true });
    await vi.waitFor(() => expect(starts).toBe(2));
    await opening;
  });
});
