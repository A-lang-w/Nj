import { describe, expect, it, vi } from "vitest";

import {
  AnalysisResourceConstraintError,
  AnalysisTargetNotOpenError,
} from "../../domain/analysisErrorCore.js";
import { ok as resultOk } from "../../domain/result.js";
import type { AnalysisClient } from "../AnalysisProvider.js";
import { observed } from "../../../tests/fixtures/analysisExecution.js";
import {
  ControllableAnalysisClient,
  createBinarySessionTargets,
  createCacheProvider,
  createDeferred,
  createTestBinaryTargetRegistry,
} from "../../../tests/fixtures/binarySession.js";

describe("BinaryTargetRegistry", () => {
  it("reopening the same target keeps its handle", async () => {
    const [first] = await createBinarySessionTargets();
    const registry = createTestBinaryTargetRegistry(createCacheProvider([]));
    expect((await registry.open(first)).ok).toBe(true);
    const openedId = registry.currentTargetId();

    expect((await registry.open(first)).ok).toBe(true);
    expect(openedId).toBeDefined();
    expect(registry.currentTargetId()).toBe(openedId);
    expect(registry.targets()).toHaveLength(1);
  });

  it("keeps two targets open and routes by target_id", async () => {
    const [first, second] = await createBinarySessionTargets();
    const seen: string[] = [];
    const registry = createTestBinaryTargetRegistry((target) => ({
      execute: (operation) => {
        if (operation !== "health") seen.push(target.sha256);
        return Promise.resolve(observed(operation));
      },
      close: () => Promise.resolve(resultOk(null)),
    }));

    const openedFirst = await registry.open(first, { keepOthersOpen: true });
    expect(openedFirst.ok).toBe(true);
    const firstId = registry.currentTargetId();
    const openedSecond = await registry.open(second, { keepOthersOpen: true });
    expect(openedSecond.ok).toBe(true);
    const secondId = registry.currentTargetId();
    expect(firstId).toBeDefined();
    expect(secondId).toBeDefined();
    expect(secondId).not.toBe(firstId);
    expect(registry.targets()).toHaveLength(2);

    const firstTarget = registry.activeTarget(firstId);
    const secondTarget = registry.activeTarget(secondId);
    expect((await registry.execute("address_name", {}, { targetId: firstId! })).ok)
      .toBe(true);
    expect((await registry.execute("address_name", {}, { targetId: secondId! })).ok)
      .toBe(true);
    expect(seen).toEqual([firstTarget?.sha256, secondTarget?.sha256]);
  });

  it("replaces other targets when keep_others_open is absent", async () => {
    const [first, second] = await createBinarySessionTargets();
    const registry = createTestBinaryTargetRegistry(createCacheProvider([]));

    expect((await registry.open(first, { keepOthersOpen: true })).ok).toBe(true);
    expect((await registry.open(second)).ok).toBe(true);

    expect(registry.targets()).toHaveLength(1);
    expect(registry.activeTarget()?.path).toBe(second);
  });

  it("refuses a new target beyond the open-target cap", async () => {
    const [first, second] = await createBinarySessionTargets();
    const registry = createTestBinaryTargetRegistry(
      createCacheProvider([]),
      {},
      { maxOpenTargets: 1 },
    );

    expect((await registry.open(first, { keepOthersOpen: true })).ok).toBe(true);
    const refused = await registry.open(second, { keepOthersOpen: true });

    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error).toBeInstanceOf(AnalysisResourceConstraintError);
    expect((refused.error as AnalysisResourceConstraintError).resource).toBe(
      "capacity",
    );
    expect(registry.targets()).toHaveLength(1);
  });

  it("reports an unknown target handle without exposing paths", async () => {
    const registry = createTestBinaryTargetRegistry(createCacheProvider([]));

    const failed = await registry.execute(
      "address_name",
      {},
      { targetId: "not-a-target" },
    );

    expect(failed.ok).toBe(false);
    if (failed.ok) return;
    expect(failed.error).toBeInstanceOf(AnalysisTargetNotOpenError);
    expect(JSON.stringify(failed.error)).not.toContain("/");
  });

  it("queues concurrent starts beyond the analysis cap", async () => {
    const [first, second] = await createBinarySessionTargets();
    const firstHealth = createDeferred<ReturnType<typeof observed>>();
    const secondHealth = createDeferred<ReturnType<typeof observed>>();
    let clientsCreated = 0;
    const registry = createTestBinaryTargetRegistry(
      () => {
        clientsCreated += 1;
        return new ControllableAnalysisClient(
          clientsCreated === 1 ? firstHealth.promise : secondHealth.promise,
        );
      },
      {},
      { maxConcurrentAnalyses: 1 },
    );

    const openingFirst = registry.open(first, { keepOthersOpen: true });
    await vi.waitFor(() => expect(clientsCreated).toBe(1));
    const openingSecond = registry.open(second, { keepOthersOpen: true });
    await Promise.resolve();

    expect(clientsCreated).toBe(1);
    firstHealth.resolve(observed(null));
    expect((await openingFirst).ok).toBe(true);

    await vi.waitFor(() => expect(clientsCreated).toBe(2));
    secondHealth.resolve(observed(null));
    expect((await openingSecond).ok).toBe(true);
    expect(registry.targets()).toHaveLength(2);
  });

  it("closes one target without discarding the other", async () => {
    const [first, second] = await createBinarySessionTargets();
    const registry = createTestBinaryTargetRegistry(createCacheProvider([]));

    expect((await registry.open(first, { keepOthersOpen: true })).ok).toBe(true);
    const firstId = registry.currentTargetId();
    expect((await registry.open(second, { keepOthersOpen: true })).ok).toBe(true);
    expect((await registry.close({ targetId: firstId! })).ok).toBe(true);

    expect(registry.targets()).toHaveLength(1);
    expect(registry.activeTarget()?.path).toBe(second);
  });

  it("closes every target on server shutdown", async () => {
    const [first, second] = await createBinarySessionTargets();
    const registry = createTestBinaryTargetRegistry(createCacheProvider([]));

    expect((await registry.open(first, { keepOthersOpen: true })).ok).toBe(true);
    expect((await registry.open(second, { keepOthersOpen: true })).ok).toBe(true);
    expect((await registry.closeAll?.()).ok).toBe(true);

    expect(registry.targets()).toHaveLength(0);
    expect(registry.activeTarget()).toBeUndefined();
  });
});

