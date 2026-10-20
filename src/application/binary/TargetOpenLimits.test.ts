import { describe, expect, it, vi } from "vitest";

import { AnalysisResourceConstraintError } from "../../domain/analysisErrorCore.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type { AnalysisProfileResolution } from "../AnalysisProvider.js";
import { createAnalysisProfile } from "../../domain/analysisProfile.js";
import { ok as resultOk, type Result } from "../../domain/result.js";
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
): Promise<void> => {
  const opened = await registry.open(path, {
    analysisMode: "background",
    keepOthersOpen: true,
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
