import { describe, expect, it, vi } from "vitest";
import { writeFile } from "node:fs/promises";

import { AnalysisTargetNotOpenError } from "../../domain/analysisErrorCore.js";
import { observed } from "../../../tests/fixtures/analysisExecution.js";
import {
  createBinarySessionTargets,
  createCacheProvider,
  createTestBinaryTargetRegistry,
} from "../../../tests/fixtures/binarySession.js";
import type { BinaryTargetRegistry } from "./BinaryTargetRegistry.js";

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
});
