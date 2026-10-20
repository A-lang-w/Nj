import { describe, expect, it, vi } from "vitest";

import {
  AnalysisCancelledError,
  AnalysisResourceConstraintError,
} from "../../domain/analysisErrorCore.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type { AnalysisProfileResolution } from "../AnalysisProvider.js";
import type { AnalysisClient } from "../AnalysisProvider.js";
import { createAnalysisProfile } from "../../domain/analysisProfile.js";
import { ProviderCleanupError } from "../../domain/providerCleanupError.js";
import { err, ok as resultOk, type Result } from "../../domain/result.js";
import { observed } from "../../../tests/fixtures/analysisExecution.js";
import {
  ControllableAnalysisClient,
  createBinarySessionTargets,
  createDeferred,
  createTestBinaryTargetRegistry,
} from "../../../tests/fixtures/binarySession.js";
import type { BinaryTargetRegistry } from "./BinaryTargetRegistry.js";

const FIXTURE_PROFILE_PROVIDER = {
  id: "fixture",
  name: "Fixture analysis provider",
  version: "1",
} as const;

/** Open one target as a background job and require the open to succeed. */
const openInBackground = async (
  registry: BinaryTargetRegistry,
  path: string,
  options: { readonly keepOthersOpen?: boolean } = {},
): Promise<void> => {
  const opened = await registry.open(path, {
    analysisMode: "background",
    keepOthersOpen: options.keepOthersOpen ?? true,
  });
  expect(opened.ok).toBe(true);
};

/**
 * The open capacity is counted before the open waits for anything.
 *
 * An open registers its slot when it finishes, so two overlapping opens used
 * to both see room for a target they were about to create and both succeed.
 */
describe("the open-target capacity", () => {
  it("refuses an overlapping foreground open beyond the cap", async () => {
    const [first, second] = await createBinarySessionTargets();
    const health = createDeferred<ReturnType<typeof observed>>();
    let clients = 0;
    const registry = createTestBinaryTargetRegistry(
      () => {
        clients += 1;
        return new ControllableAnalysisClient(health.promise);
      },
      {},
      { maxOpenTargets: 1 },
    );

    const openingFirst = registry.open(first, { keepOthersOpen: true });
    await vi.waitFor(() => expect(clients).toBe(1));

    const refused = await registry.open(second, { keepOthersOpen: true });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error).toBeInstanceOf(AnalysisResourceConstraintError);

    health.resolve(observed(null));
    expect((await openingFirst).ok).toBe(true);
    expect(registry.targets()).toHaveLength(1);
  });

  it("refuses an overlapping background open beyond the cap", async () => {
    const [first, second] = await createBinarySessionTargets();
    const health = createDeferred<ReturnType<typeof observed>>();
    // The first open waits for its profile, so the second open reaches the
    // capacity check while the first one still holds its slot.
    const profile =
      createDeferred<Result<AnalysisProfileResolution, AnalysisError>>();
    let profileRequested = false;
    const registry = createTestBinaryTargetRegistry(
      () => new ControllableAnalysisClient(health.promise),
      {
        resolveAnalysisProfile: (target) => {
          if (target.path !== first)
            return Promise.resolve(
              resultOk({
                profile: createAnalysisProfile(FIXTURE_PROFILE_PROVIDER, {
                  fixture: true,
                }),
              }),
            );
          profileRequested = true;
          return profile.promise;
        },
      },
      { maxOpenTargets: 1 },
    );

    const openingFirst = registry.open(first, {
      analysisMode: "background",
      keepOthersOpen: true,
    });
    // The first open holds its slot while it waits for the profile.
    await vi.waitFor(() => expect(profileRequested).toBe(true));

    const refused = await registry.open(second, {
      analysisMode: "background",
      keepOthersOpen: true,
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error).toBeInstanceOf(AnalysisResourceConstraintError);

    profile.resolve(
      resultOk({
        profile: createAnalysisProfile(FIXTURE_PROFILE_PROVIDER, {
          fixture: true,
        }),
      }),
    );
    health.resolve(observed(null));
    expect((await openingFirst).ok).toBe(true);
    expect(registry.targets()).toHaveLength(1);
  });
});

/**
 * A start that never unwinds gives its permit back when the close gives up
 * on it. Otherwise every later start waits for a start that will never
 * finish, and the analysis cap becomes a wall.
 */
describe("the start permit of a start that never unwinds", () => {
  it("is returned by the close that gave up on the start", async () => {
    const [first, second] = await createBinarySessionTargets();
    let clients = 0;
    const registry = createTestBinaryTargetRegistry(
      () => {
        clients += 1;
        return {
          execute: () =>
            new Promise<ReturnType<typeof observed>>(() => undefined),
          close: () => Promise.resolve(resultOk(null)),
        };
      },
      {},
      { maxConcurrentAnalyses: 1, jobSettleTimeoutMs: 50 },
    );

    await openInBackground(registry, first);
    await vi.waitFor(() => expect(clients).toBe(1));
    const firstId = registry.currentTargetId();
    expect(firstId).toBeDefined();

    // The close gives up on the start that ignores its abort.
    expect((await registry.close({ targetId: firstId! })).ok).toBe(true);

    // A later start is not queued behind the start that never unwound.
    await openInBackground(registry, second);
    await vi.waitFor(() => expect(clients).toBe(2));
  });
});

/**
 * The state of a provider a forced close cannot release.
 *
 * The provider's start never unwinds and its close is refused, so the forced
 * close leaves the provider running and the retained cleanup keeps the start
 * permit until a later close releases it.
 */
type RetainedCleanupState = {
  /** The clients the registry created. */
  clients: number;
  /** The closes the clients were asked for. */
  closes: number;
  /** Whether a close after the forced one is refused too. */
  refuseClose: boolean;
  /** The close a retry waits for, when the test has to interleave with it. */
  retry?: { readonly promise: Promise<Result<null, AnalysisError>> };
};

/** The refusal of a provider that a close cannot release. */
const refusedCleanup = (): AnalysisError =>
  new ProviderCleanupError("fixture", ["provider-client"], {
    reason: "fixture close refused",
  });

/**
 * A provider whose first start never unwinds and whose close can refuse.
 *
 * The forced close cannot release that provider, so the retained cleanup
 * keeps the start permit until a later close releases it.
 */
const retainedCleanupProvider = (
  state: RetainedCleanupState,
): AnalysisClient => ({
  // The first start never unwinds, so the close has to release the client.
  execute: () =>
    state.clients === 1
      ? new Promise<ReturnType<typeof observed>>(() => undefined)
      : Promise.resolve(observed(null)),
  close: () => {
    state.closes += 1;
    // The forced close is refused, so the cleanup of that provider stays
    // pending and the retained cleanup owns it.
    if (state.closes === 1) return Promise.resolve(err(refusedCleanup()));
    // A retry waits for the test, so a request can be cancelled while it
    // runs.
    if (state.retry !== undefined) return state.retry.promise;
    return state.refuseClose
      ? Promise.resolve(err(refusedCleanup()))
      : Promise.resolve(resultOk(null));
  },
});

/**
 * Open the first target as a start that never unwinds and refuse its close.
 *
 * The forced close cannot release the provider, so it stays alive and the
 * retained cleanup keeps the start permit.
 */
const openWithRetainedCleanup = async (
  registry: BinaryTargetRegistry,
  state: RetainedCleanupState,
  path: string,
  options: { readonly keepOthersOpen?: boolean } = {},
): Promise<string> => {
  await openInBackground(registry, path, options);
  await vi.waitFor(() => expect(state.clients).toBe(1));
  const targetId = registry.currentTargetId();
  expect(targetId).toBeDefined();
  expect((await registry.close({ targetId: targetId! })).ok).toBe(false);
  return targetId!;
};

/** The registry whose provider a forced close cannot release. */
const retainedCleanupRegistry = (
  state: RetainedCleanupState,
): BinaryTargetRegistry =>
  createTestBinaryTargetRegistry(
    () => {
      state.clients += 1;
      return retainedCleanupProvider(state);
    },
    {},
    { maxConcurrentAnalyses: 1, jobSettleTimeoutMs: 50 },
  );

/**
 * The start permit of a provider the close could not release.
 *
 * A forced close that cannot stop the provider leaves it running, so the
 * analysis cap has to count it. The retained cleanup owns the permit until
 * it succeeds; giving it back earlier would let a later start run beside a
 * provider that is still alive.
 */
describe("the start permit of a retained cleanup", () => {
  it("is kept until the retained cleanup releases the provider", async () => {
    const [first, second] = await createBinarySessionTargets();
    const state = { clients: 0, closes: 0, refuseClose: true };
    const registry = retainedCleanupRegistry(state);

    const firstId = await openWithRetainedCleanup(registry, state, first);

    // The provider is still running, so the next start waits for its permit.
    const opening = openInBackground(registry, second);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(state.clients).toBe(1);

    // The retained cleanup releases the provider and gives the permit back.
    state.refuseClose = false;
    expect((await registry.close({ targetId: firstId })).ok).toBe(true);
    await vi.waitFor(() => expect(state.clients).toBe(2));
    await opening;
  });

  it("is retried before a replacement open waits for the permit", async () => {
    const [first, second] = await createBinarySessionTargets();
    const state = { clients: 0, closes: 0, refuseClose: true };
    const registry = retainedCleanupRegistry(state);

    await openWithRetainedCleanup(registry, state, first, {
      keepOthersOpen: false,
    });

    // The provider can be released now.
    state.refuseClose = false;

    // The replacement open retries the retained cleanup instead of waiting
    // for the permit that the cleanup owns: the open would only retry the
    // cleanup after it took that permit.
    const opening = registry.open(second);
    await vi.waitFor(() => expect(state.clients).toBe(2), { timeout: 2_000 });
    expect((await opening).ok).toBe(true);
  });
});

/**
 * A start that is cancelled while the retained cleanup is retried.
 *
 * The retained cleanup is retried before the start permit is taken, so the
 * request waits for that retry. A request that is cancelled while the retry
 * runs must neither take the permit nor enter the queue: the abort event has
 * already fired, so a listener attached after it never runs and the request
 * waits for a permit that may never come.
 */
describe("a start that is cancelled while the retained cleanup is retried", () => {
  it("reports the cancellation instead of waiting for a permit", async () => {
    const [first, second] = await createBinarySessionTargets();
    const retry = createDeferred<Result<null, AnalysisError>>();
    const state = {
      clients: 0,
      closes: 0,
      refuseClose: true,
      retry,
    };
    const registry = retainedCleanupRegistry(state);

    await openWithRetainedCleanup(registry, state, first);
    expect(state.closes).toBe(1);

    // The next open retries the retained cleanup before it takes the permit
    // that the cleanup owns.
    const controller = new AbortController();
    const opening = registry.open(second, {
      keepOthersOpen: true,
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(state.closes).toBe(2));

    // The request is cancelled while the cleanup retry runs.
    controller.abort();
    retry.resolve(err(refusedCleanup()));

    // The cancelled request reports the cancellation instead of waiting for
    // a permit that may never come.
    const settled = await Promise.race([
      opening,
      new Promise<undefined>((resolve) => {
        const timer = setTimeout(() => resolve(undefined), 500);
        timer.unref?.();
      }),
    ]);
    expect(settled).toBeDefined();
    if (settled === undefined) return;
    expect(settled.ok).toBe(false);
    if (settled.ok) return;
    expect(settled.error).toBeInstanceOf(AnalysisCancelledError);
  });
});
