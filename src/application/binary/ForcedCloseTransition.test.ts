import { describe, expect, it, vi } from "vitest";

import { AnalysisCancelledError } from "../../domain/analysisErrorCore.js";
import { ProviderCleanupError } from "../../domain/providerCleanupError.js";
import { err, ok as resultOk } from "../../domain/result.js";
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
