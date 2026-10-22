import { describe, expect, it, vi } from "vitest";

import { AnalysisCancelledError } from "../../domain/analysisErrorCore.js";
import { HopperStartError } from "../../domain/hopperErrors.js";
import { ProviderCleanupError } from "../../domain/providerCleanupError.js";
import { err, ok as resultOk, type Result } from "../../domain/result.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type { AnalysisExecution } from "../AnalysisProvider.js";
import { observed } from "../../../tests/fixtures/analysisExecution.js";
import {
  createBinarySessionTargets,
  createDeferred,
  createTestBinarySession,
  WedgedAnalysisClient,
} from "../../../tests/fixtures/binarySession.js";
import type { AnalysisClient } from "../AnalysisProvider.js";

/** A provider that answers at once, including the reads that need no provider. */
const healthyClient = (): AnalysisClient => ({
  execute: () => Promise.resolve(observed(null)),
  executeIfReady: (operation) => Promise.resolve(observed(operation)),
  close: () => Promise.resolve(resultOk(null)),
});

/**
 * A forced close retires the transition chain.
 *
 * The chain that carried a start that ignored its abort can never settle, so
 * the forced close replaces it. The requests that were queued behind that
 * start addressed the target the close took away: they must be rejected
 * instead of running against the target that replaces it, and the abandoned
 * start must not keep the session's reads disabled.
 */
describe("a forced close of a start that never unwinds", () => {
  it("rejects a request that was queued behind the abandoned start", async () => {
    const [first] = await createBinarySessionTargets();
    let clients = 0;
    const session = createTestBinarySession(() => {
      clients += 1;
      return clients === 1 ? new WedgedAnalysisClient() : healthyClient();
    });

    // The open never unwinds, so the request below waits behind it.
    void session.open(first).catch(() => undefined);
    let ran = false;
    const queued = session.withAdmittedExternalMutation(
      undefined,
      undefined,
      async () => {
        ran = true;
        return resultOk(null);
      },
      () => new AnalysisCancelledError("execute_rizin_command"),
    );

    const closed = await session.closeWithoutTransition(
      {},
      { clearRecords: true, closeOwnedProviderResources: true },
    );
    expect(closed.ok).toBe(true);

    // The queued request is rejected instead of running against the target
    // that takes the closed one's place.
    const settled = await queued;
    expect(settled.ok).toBe(false);
    if (settled.ok) return;
    expect(settled.error).toBeInstanceOf(AnalysisCancelledError);
    expect(ran).toBe(false);
  });

  it("stops counting the abandoned start as a pending request", async () => {
    const [first, second] = await createBinarySessionTargets();
    let clients = 0;
    const session = createTestBinarySession(() => {
      clients += 1;
      return clients === 1 ? new WedgedAnalysisClient() : healthyClient();
    });

    void session.open(first).catch(() => undefined);
    await vi.waitFor(() => expect(clients).toBe(1));

    const closed = await session.closeWithoutTransition(
      {},
      { clearRecords: true, closeOwnedProviderResources: true },
    );
    expect(closed.ok).toBe(true);

    // The slot is usable again.
    expect((await session.open(second)).ok).toBe(true);

    // The abandoned start does not keep the session's reads disabled.
    const suggestion = await session.executeIfProviderReady("address_name", {});
    expect(suggestion).toBeDefined();
  });

  it("rejects an analysis that waited for the abandoned start", async () => {
    const [first] = await createBinarySessionTargets();
    let clients = 0;
    const session = createTestBinarySession(() => {
      clients += 1;
      return clients === 1 ? new WedgedAnalysisClient() : healthyClient();
    });

    void session.open(first).catch(() => undefined);
    let ran = false;
    const queued = session.withAdmittedAnalysis(
      "address_name",
      undefined,
      async () => {
        ran = true;
        return null;
      },
    );

    const closed = await session.closeWithoutTransition(
      {},
      { clearRecords: true, closeOwnedProviderResources: true },
    );
    expect(closed.ok).toBe(true);

    const settled = await queued;
    expect(settled.ok).toBe(false);
    if (settled.ok) return;
    expect(settled.error).toBeInstanceOf(AnalysisCancelledError);
    expect(ran).toBe(false);
  });
});

/**
 * A request that was rejected by a retired transition reports the failure it
 * was given, so a caller can tell it apart from a provider failure.
 */
describe("a request rejected by a retired transition", () => {
  it("reports a cancellation", async () => {
    const [first] = await createBinarySessionTargets();
    const session = createTestBinarySession(() => new WedgedAnalysisClient());

    void session.open(first);
    const queued = session.execute("address_name", {});
    const closed = await session.closeWithoutTransition(
      {},
      { clearRecords: true, closeOwnedProviderResources: true },
    );
    expect(closed.ok).toBe(true);

    const settled = await queued;
    expect(settled.ok).toBe(false);
    if (settled.ok) return;
    expect(settled.error).toBeInstanceOf(AnalysisCancelledError);
  });
});

/**
 * A provider that a retry released is not closed a second time.
 *
 * The cleanup of a provider a close could not release is retried by the
 * caller that waits for it. The client is closed then, so the run that owns
 * it owns no cleanup any more: the start that never unwound must not close
 * it again when it finally unwinds.
 */
describe("a provider that a retry released", () => {
  it("is not closed again when the abandoned start unwinds", async () => {
    const [first] = await createBinarySessionTargets();
    const health = createDeferred<ReturnType<typeof observed>>();
    let clients = 0;
    let closes = 0;
    let refuseClose = true;
    const session = createTestBinarySession(() => {
      clients += 1;
      return {
        execute: () => health.promise,
        close: () => {
          closes += 1;
          return Promise.resolve(
            refuseClose
              ? err(
                  new ProviderCleanupError("fixture", ["provider-client"], {
                    reason: "fixture close refused",
                  }),
                )
              : resultOk(null),
          );
        },
      };
    });

    const opening = session.open(first);
    await vi.waitFor(() => expect(clients).toBe(1));

    // The forced close cannot release the provider.
    const closed = await session.closeWithoutTransition(
      {},
      { clearRecords: true, closeOwnedProviderResources: true },
    );
    expect(closed.ok).toBe(false);
    expect(closes).toBe(1);

    // The provider is released by the retry.
    refuseClose = false;
    expect((await session.releasePendingProvider()).ok).toBe(true);
    expect(closes).toBe(2);

    // The abandoned start unwinds, and the client it started is already closed.
    health.resolve(observed(null));
    const settled = await opening;
    expect(settled.ok).toBe(false);
    expect(closes).toBe(2);
  });
});

/**
 * A failed start does not restore a target into a closed slot.
 *
 * The cleanup of a failed start restores the target the open replaced, and a
 * forced close retired that slot while the start was in flight. A target
 * restored into a closed slot would take the slot back from the target that
 * replaced it, so the cleanup leaves the closed slot closed.
 */
describe("a failed start that unwinds after a forced close", () => {
  it("does not restore the target the closed slot held", async () => {
    const [first, second] = await createBinarySessionTargets();
    const health = createDeferred<Result<AnalysisExecution, AnalysisError>>();
    let clients = 0;
    let closes = 0;
    const session = createTestBinarySession(() => {
      clients += 1;
      const client = clients;
      return {
        execute: () =>
          client === 2 ? health.promise : Promise.resolve(observed(null)),
        close: () => {
          closes += 1;
          return Promise.resolve(resultOk(null));
        },
      };
    });

    expect((await session.open(first)).ok).toBe(true);

    // The replacement starts a provider that never settles.
    const replacing = session.open(second);
    await vi.waitFor(() => expect(clients).toBe(2));

    // The forced close retires the slot while the start is in flight.
    const closed = await session.closeWithoutTransition(
      {},
      { clearRecords: true, closeOwnedProviderResources: true },
    );
    expect(closed.ok).toBe(true);
    expect(closes).toBe(2);

    // The start fails after the close.
    health.resolve(err(new HopperStartError()));
    const settled = await replacing;
    expect(settled.ok).toBe(false);

    // The closed slot holds no target, and no client was created to restore
    // the one it held before the failed open.
    expect(session.activeTarget()).toBeUndefined();
    expect(clients).toBe(2);
  });

  it("does not bind the restored target when the slot closes while the restoration waits", async () => {
    const [first, second] = await createBinarySessionTargets();
    const failing = createDeferred<Result<AnalysisExecution, AnalysisError>>();
    const restoring =
      createDeferred<Result<AnalysisExecution, AnalysisError>>();
    let clients = 0;
    let closes = 0;
    const session = createTestBinarySession(() => {
      clients += 1;
      const client = clients;
      return {
        execute: () => {
          if (client === 2) return failing.promise;
          if (client === 3) return restoring.promise;
          return Promise.resolve(observed(null));
        },
        close: () => {
          closes += 1;
          return Promise.resolve(resultOk(null));
        },
      };
    });

    expect((await session.open(first)).ok).toBe(true);

    const replacing = session.open(second);
    await vi.waitFor(() => expect(clients).toBe(2));

    // The start fails, so the cleanup restores the target the open replaced.
    failing.resolve(err(new HopperStartError()));
    await vi.waitFor(() => expect(clients).toBe(3));

    // The slot is closed while the restoration waits for its client.
    const closed = await session.closeWithoutTransition(
      {},
      { clearRecords: true, closeOwnedProviderResources: true },
    );
    expect(closed.ok).toBe(true);

    // The restoration answers, but the slot it would bind is closed.
    restoring.resolve(observed(null));
    const settled = await replacing;
    expect(settled.ok).toBe(false);
    expect(session.activeTarget()).toBeUndefined();
    // The restored client is released instead of bound to a closed slot.
    expect(closes).toBe(3);
  });
});
