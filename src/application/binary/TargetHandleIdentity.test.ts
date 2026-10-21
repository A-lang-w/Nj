import { describe, expect, it, vi } from "vitest";
import { writeFile } from "node:fs/promises";

import { AnalysisTargetNotOpenError } from "../../domain/analysisErrorCore.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type { BinaryTarget } from "../../domain/binaryTargetTypes.js";
import { ProviderAdapterError } from "../../domain/providerAdapterError.js";
import { err, ok as resultOk, type Result } from "../../domain/result.js";
import { observed } from "../../../tests/fixtures/analysisExecution.js";
import {
  createBinarySessionTargets,
  createCacheProvider,
  createDeferred,
  createTestBinaryTargetRegistry,
} from "../../../tests/fixtures/binarySession.js";
import type { BinaryTargetRegistry } from "./BinaryTargetRegistry.js";
import type { OpenedTarget } from "./BinarySessionPort.js";

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
 * Reopen the primary target while another target takes its slot over.
 *
 * The reopen reuses the target the primary holds, so it closes the other
 * target first, and that close waits. While it waits, the file at the first
 * path is a different binary and a foreground open takes the new target into
 * the reused slot. The reopen has to answer for the target it asked for, not
 * for the replacement that took the slot over.
 */
const reopenWhileTheSlotChanges = async (
  first: string,
  second: string,
  reopen: (
    registry: BinaryTargetRegistry,
    target: BinaryTarget,
  ) => Promise<Result<OpenedTarget, AnalysisError>>,
): Promise<{
  readonly answered: Result<OpenedTarget, AnalysisError>;
  readonly requested: string;
}> => {
  const closing = createDeferred<void>();
  const release = createDeferred<Result<null, AnalysisError>>();
  const registry = createTestBinaryTargetRegistry((target) => ({
    execute: (operation: string) => Promise.resolve(observed(operation)),
    close: () => {
      if (target.path !== second) return Promise.resolve(resultOk(null));
      closing.resolve(undefined);
      return release.promise;
    },
  }));

  // The first target takes the primary slot, the second one a slot of its own.
  expect((await registry.open(first)).ok).toBe(true);
  const target = registry.activeTarget();
  expect(target).toBeDefined();
  const requested = target?.sha256;
  expect(requested).toBeDefined();
  expect((await registry.open(second, { keepOthersOpen: true })).ok).toBe(true);

  // The reopen waits for the other target to close.
  const answered = reopen(registry, target!);
  await closing.promise;

  // While it waits, the file at that path is a different binary and the slot
  // takes the new target.
  await writeFile(first, "rebuilt-binary");
  expect((await registry.open(first, { keepOthersOpen: true })).ok).toBe(true);
  expect(registry.activeTarget()?.sha256).not.toBe(requested);

  release.resolve(resultOk(null));
  return { answered: await answered, requested: requested! };
};

/**
 * A handle names one live target.
 *
 * The registry reuses a slot for a replacement target, so a handle that
 * named the previous target would otherwise select the replacement and let a
 * caller read, annotate or close the wrong binary.
 */
describe("a target handle", () => {
  it("gives a replacement target its own handle", async () => {
    const [first, second] = await createBinarySessionTargets();
    const registry = createTestBinaryTargetRegistry(createCacheProvider([]));

    expect((await registry.open(first)).ok).toBe(true);
    const firstId = registry.currentTargetId();
    expect((await registry.open(second)).ok).toBe(true);
    const secondId = registry.currentTargetId();

    expect(firstId).toBeDefined();
    expect(secondId).toBeDefined();
    expect(secondId).not.toBe(firstId);
    // The old handle does not select the replacement.
    expect(() => registry.providerIdentity(undefined, firstId!)).toThrow(
      AnalysisTargetNotOpenError,
    );
    expect(registry.activeTarget(secondId)?.path).toBe(second);
  });

  it("does not let a closed handle select a later target", async () => {
    const [first, second] = await createBinarySessionTargets();
    const registry = createTestBinaryTargetRegistry(createCacheProvider([]));

    expect((await registry.open(first)).ok).toBe(true);
    const firstId = registry.currentTargetId();
    expect((await registry.close({ targetId: firstId! })).ok).toBe(true);
    expect((await registry.open(second)).ok).toBe(true);

    expect(registry.currentTargetId()).not.toBe(firstId);
    expect(() => registry.providerIdentity(undefined, firstId!)).toThrow(
      AnalysisTargetNotOpenError,
    );
    expect(registry.activeTarget()?.path).toBe(second);
  });

  it("keeps the handle of the target it still holds", async () => {
    const [first] = await createBinarySessionTargets();
    const registry = createTestBinaryTargetRegistry(createCacheProvider([]));

    expect((await registry.open(first)).ok).toBe(true);
    const firstId = registry.currentTargetId();
    expect((await registry.open(first)).ok).toBe(true);

    expect(registry.currentTargetId()).toBe(firstId);
    expect(registry.targets()).toHaveLength(1);
  });
});

/**
 * A reused background job answers for its own slot.
 *
 * The MCP handler reads the handle and the analysis state of the current
 * target, so a reused job that does not become current is reported with the
 * handle of a different target.
 */
describe("a reused background job", () => {
  it("makes its own slot the current target", async () => {
    const [first, second] = await createBinarySessionTargets();
    const registry = createTestBinaryTargetRegistry(createCacheProvider([]));

    await openInBackground(registry, first);
    const firstId = registry.currentTargetId();

    await openInBackground(registry, second);
    const secondId = registry.currentTargetId();
    expect(secondId).not.toBe(firstId);
    await vi.waitFor(() =>
      expect(registry.analysisState(secondId)).toMatchObject({
        state: "ready",
      }),
    );

    // Reopening the first target answers for the first target again.
    await openInBackground(registry, first);

    expect(registry.currentTargetId()).toBe(firstId);
    expect(registry.analysisState()).toMatchObject({ state: "ready" });
  });
});

/**
 * A background open reuses an open target only when it is the same target.
 *
 * The reuse used to match on the path alone, so a rebuilt binary at that
 * path kept the old analysis, and an explicit provider switch or a staged
 * snapshot was silently ignored.
 */
describe("a reused background target", () => {
  it("does not reuse the analysis of a rebuilt binary at the same path", async () => {
    const [first] = await createBinarySessionTargets();
    const registry = createTestBinaryTargetRegistry(createCacheProvider([]));

    await openInBackground(registry, first);
    const firstId = registry.currentTargetId();

    // The file at that path is a different binary now.
    await writeFile(first, "rebuilt-binary");

    await openInBackground(registry, first);

    expect(registry.currentTargetId()).not.toBe(firstId);
    expect(registry.activeTarget()?.sha256).not.toBe(
      registry.activeTarget(firstId)?.sha256,
    );
  });

  it("does not reuse an open target when the caller asks for another provider", async () => {
    const [first] = await createBinarySessionTargets();
    const registry = createTestBinaryTargetRegistry(createCacheProvider([]));

    await openInBackground(registry, first);
    const firstId = registry.currentTargetId();

    // The requested provider does not exist, so the open fails instead of
    // reporting the target the previous provider opened.
    const switched = await registry.open(first, {
      analysisMode: "background",
      keepOthersOpen: true,
      providerId: "another-provider",
    });

    expect(switched.ok).toBe(false);
    expect(registry.currentTargetId()).toBe(firstId);
  });

  it("keeps the analysis of the target it still holds", async () => {
    const [first] = await createBinarySessionTargets();
    const seen: string[] = [];
    const registry = createTestBinaryTargetRegistry((target) => ({
      execute: (operation: string) => {
        if (operation !== "health") seen.push(target.sha256);
        return Promise.resolve(observed(operation));
      },
      close: () => Promise.resolve({ ok: true } as never),
    }));

    await openInBackground(registry, first);
    const firstId = registry.currentTargetId();

    await openInBackground(registry, first);

    // The reused target kept its handle and its analysis.
    expect(registry.currentTargetId()).toBe(firstId);
    expect(registry.targets()).toHaveLength(1);
    expect(seen).toEqual([]);
  });

  /**
   * A background request that replaces the targets still replaces them.
   *
   * A background open that reuses the target the primary already holds skips
   * the replace path, so the other targets stayed open although the request
   * asked to replace them.
   */
  it("closes the other targets when the request replaces them", async () => {
    const [first, second] = await createBinarySessionTargets();
    const registry = createTestBinaryTargetRegistry(createCacheProvider([]));

    // The first target takes the primary slot, the second one a slot of its own.
    expect((await registry.open(first)).ok).toBe(true);
    expect((await registry.open(second, { keepOthersOpen: true })).ok).toBe(
      true,
    );
    expect(registry.targets()).toHaveLength(2);
    const secondId = registry.currentTargetId();

    // The background reopen of the primary target replaces the other targets.
    const reopened = await registry.open(first, { analysisMode: "background" });
    expect(reopened.ok).toBe(true);

    expect(registry.targets()).toHaveLength(1);
    expect(registry.targets()[0]?.target_id).not.toBe(secondId);
    expect(registry.activeTarget()?.path).toBe(first);
  });

  /**
   * A reuse that a wait made stale answers for another target.
   *
   * The background open closes the other targets before it answers for the
   * reused one, and that close waits. A foreground open of the same path can
   * replace the slot while the close waits, so the reuse answered for the
   * replacement instead of the target the request asked for.
   */
  it("does not answer for a target that took the reused slot over", async () => {
    const [first, second] = await createBinarySessionTargets();

    const { answered, requested } = await reopenWhileTheSlotChanges(
      first,
      second,
      (registry) => registry.open(first, { analysisMode: "background" }),
    );

    // The answer is the target the request asked for, not the replacement
    // that took the slot over while the request waited.
    expect(answered.ok).toBe(true);
    if (!answered.ok) return;
    expect(answered.value.target.sha256).toBe(requested);
  });

  /**
   * A resolved open shares the reuse rule.
   *
   * A resolved background open closes the other targets before it answers
   * for the reused one, and that close waits, so the same stale reuse
   * applies to it.
   */
  it("does not answer a resolved open for a target that took the slot over", async () => {
    const [first, second] = await createBinarySessionTargets();

    const { answered, requested } = await reopenWhileTheSlotChanges(
      first,
      second,
      async (registry, target) => {
        const preview = await registry.previewTarget(target);
        if (!preview.ok) return preview;
        return registry.openResolvedTarget(
          { target: preview.value.target, route: preview.value.route },
          { analysisMode: "background" },
        );
      },
    );

    expect(answered.ok).toBe(true);
    if (!answered.ok) return;
    expect(answered.value.target.sha256).toBe(requested);
  });
});

/**
 * A handle of a background job that did not become ready.
 *
 * A failed background open restores the target the session held before, so
 * the slot holds a live target the job never opened. The handle the job was
 * minted for names the target that never opened, so it must not select the
 * restored one.
 */
describe("a background job that did not become ready", () => {
  it("retires the handle of the failed job and keeps the restored target", async () => {
    const [first, second] = await createBinarySessionTargets();
    const registry = createTestBinaryTargetRegistry((target) => ({
      execute: (operation: string) =>
        operation === "health" && target.path === second
          ? Promise.resolve(err(new ProviderAdapterError("fixture", "health")))
          : Promise.resolve(observed(operation)),
      close: () => Promise.resolve(resultOk(null)),
    }));

    // The first target is open, and the background open replaces it.
    expect((await registry.open(first)).ok).toBe(true);
    const firstId = registry.currentTargetId();
    expect(firstId).toBeDefined();

    const started = await registry.open(second, { analysisMode: "background" });
    expect(started.ok).toBe(true);
    const failedId = registry.currentTargetId();
    expect(failedId).not.toBe(firstId);
    await vi.waitFor(() =>
      expect(registry.analysisState()).toMatchObject({
        state: "failed",
      }),
    );

    // The handle of the failed job does not select the restored target.
    const closed = await registry.close({ targetId: failedId! });
    expect(closed.ok).toBe(false);
    expect(registry.activeTarget()?.path).toBe(first);

    // The restored target has its own handle, and that handle closes it.
    const restoredId = registry.currentTargetId();
    expect(restoredId).toBeDefined();
    expect(restoredId).not.toBe(failedId);
    expect((await registry.close({ targetId: restoredId! })).ok).toBe(true);
    expect(registry.targets()).toHaveLength(0);
  });
});
