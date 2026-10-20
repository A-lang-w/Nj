import { describe, expect, it, vi } from "vitest";

import { AnalysisCancelledError } from "../../domain/analysisErrorCore.js";
import { observed } from "../../../tests/fixtures/analysisExecution.js";
import {
  createBinarySessionTargets,
  createCacheProvider,
  createTestProviderRouter,
  WedgedAnalysisClient,
} from "../../../tests/fixtures/binarySession.js";
import { BinarySession } from "./BinarySession.js";
import {
  createTransitionRetirement,
  type TransitionRetirement,
} from "./TransitionRetirement.js";

/** Record the retirement of every epoch a session creates. */
const observedEpochs = (
  provider: Parameters<typeof createTestProviderRouter>[0],
): {
  readonly session: BinarySession;
  readonly epochs: TransitionRetirement[];
} => {
  const epochs: TransitionRetirement[] = [];
  const session = new BinarySession(
    createTestProviderRouter(provider),
    undefined,
    () => {
      const retirement = createTransitionRetirement();
      epochs.push(retirement);
      return retirement;
    },
  );
  return { session, epochs };
};

/**
 * The retirement of a transition epoch.
 *
 * The retirement is shared by every request of the epoch, so a request
 * attaches a listener instead of racing a shared promise. A request that
 * settled for another reason detaches its listener, so the epoch keeps
 * nothing for it.
 */
describe("the retirement of a transition epoch", () => {
  it("releases the listeners that wait for it", () => {
    const retirement = createTransitionRetirement();
    let released = 0;
    retirement.subscribe(() => {
      released += 1;
    });
    expect(retirement.attached).toBe(1);

    retirement.retire();

    expect(released).toBe(1);
    expect(retirement.attached).toBe(0);
  });

  it("keeps nothing for a listener that stopped waiting", () => {
    const retirement = createTransitionRetirement();
    let released = 0;
    const detach = retirement.subscribe(() => {
      released += 1;
    });
    detach();
    expect(retirement.attached).toBe(0);

    retirement.retire();

    expect(released).toBe(0);
  });

  it("releases a listener that attaches after the retirement", () => {
    const retirement = createTransitionRetirement();
    retirement.retire();
    let released = 0;

    retirement.subscribe(() => {
      released += 1;
    });

    expect(released).toBe(1);
    expect(retirement.attached).toBe(0);
  });
});

/**
 * The epoch of a session keeps no waiter for a request that settled.
 *
 * Every ordinary request waits for the epoch's transition chain or for the
 * epoch's retirement. A request that settled for another reason has to
 * detach itself, so a long-lived session does not retain the requests that
 * already finished.
 */
describe("the epoch of a session", () => {
  it("keeps no waiter for a request that settled", async () => {
    const [first] = await createBinarySessionTargets();
    const { session, epochs } = observedEpochs(createCacheProvider([]));

    expect((await session.open(first)).ok).toBe(true);
    for (let index = 0; index < 5; index += 1)
      expect((await session.execute("address_name", {})).ok).toBe(true);

    expect(epochs).toHaveLength(1);
    expect(epochs[0]?.attached).toBe(0);
  });

  it("releases a waiting request when the epoch is retired", async () => {
    const [first] = await createBinarySessionTargets();
    const { session, epochs } = observedEpochs(
      () => new WedgedAnalysisClient(),
    );

    // The open never unwinds, so the request below waits behind it.
    void session.open(first).catch(() => undefined);
    const waiting = session.execute("address_name", {});
    await vi.waitFor(() => expect(epochs[0]?.attached).toBe(1));

    const closed = await session.closeWithoutTransition(
      {},
      { clearRecords: true, closeOwnedProviderResources: true },
    );
    expect(closed.ok).toBe(true);

    // The retired epoch rejects the request it held instead of leaving it
    // waiting, and it keeps nothing for it afterwards.
    const settled = await waiting;
    expect(settled.ok).toBe(false);
    if (settled.ok) return;
    expect(settled.error).toBeInstanceOf(AnalysisCancelledError);
    expect(epochs[0]?.attached).toBe(0);
  });
});
