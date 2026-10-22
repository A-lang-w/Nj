import { describe, expect, it } from "vitest";

import {
  createWorkflowEvidence,
  workflowSnapshotRecord,
} from "../WorkflowEvidence.js";
import {
  createBinarySessionTargets,
  createCacheProvider,
  createDeferred,
  createTestBinaryTargetRegistry,
} from "../../../tests/fixtures/binarySession.js";

/**
 * The Evidence of a request belongs to the target the request ran against.
 *
 * A request is admitted for one target, and its provider calls run against
 * that target. Another open may make another target current while the request
 * runs, and the Evidence of the request does not follow the current target.
 */
describe("the Evidence of an admitted request", () => {
  it("names the target the request was admitted for", async () => {
    const [first, second] = await createBinarySessionTargets();
    const registry = createTestBinaryTargetRegistry(createCacheProvider([]));

    expect((await registry.open(first, { keepOthersOpen: true })).ok).toBe(
      true,
    );
    const firstId = registry.currentTargetId();
    expect(firstId).toBeDefined();

    const release = createDeferred<void>();
    const admitted = registry.withAdmittedAnalysis(
      "binary_overview",
      undefined,
      async () => {
        await release.promise;
        return registry.activeTarget()?.path;
      },
      firstId,
    );

    // Another open makes another target current while the request runs.
    expect((await registry.open(second, { keepOthersOpen: true })).ok).toBe(
      true,
    );
    expect(registry.activeTarget()?.path).toBe(second);

    release.resolve();
    const answered = await admitted;
    expect(answered.ok).toBe(true);
    if (!answered.ok) return;
    expect(answered.value).toBe(first);
  });

  it("writes the workflow snapshot into the slot it was admitted for", async () => {
    const [first, second] = await createBinarySessionTargets();
    const registry = createTestBinaryTargetRegistry(createCacheProvider([]));

    expect((await registry.open(first, { keepOthersOpen: true })).ok).toBe(
      true,
    );
    const firstId = registry.currentTargetId();
    expect(firstId).toBeDefined();
    expect((await registry.open(second, { keepOthersOpen: true })).ok).toBe(
      true,
    );
    const secondId = registry.currentTargetId();
    expect(secondId).toBeDefined();

    const recorded = await registry.withAdmittedAnalysis(
      "binary_overview",
      undefined,
      async () => {
        const profile = registry.analysisProfile();
        if (profile === undefined) return "no-profile";
        const evidence = createWorkflowEvidence({
          target: registry.activeTarget(),
          operation: "binary_overview",
          parameters: {},
          result: { observed: true },
          upstreamProfile: profile,
          upstreamLimitations: [],
        });
        const recorded = registry.recordEvidence(evidence);
        if (!recorded.ok) return "rejected-evidence";
        const record = workflowSnapshotRecord(
          evidence,
          "binary_overview",
          profile,
        );
        if (record === undefined) return "no-record";
        return registry.recordWorkflowSnapshot(record).ok
          ? "recorded"
          : "rejected";
      },
      firstId,
    );
    expect(recorded.ok).toBe(true);
    if (!recorded.ok) return;
    expect(recorded.value).toBe("recorded");

    // The workflow entry belongs to the snapshot of the admitted target.
    const firstEntries = await registry.withAdmittedAnalysis(
      "binary_overview",
      undefined,
      async () => {
        const snapshot = registry.exportAnalysisSnapshot();
        return snapshot.ok ? snapshot.value.workflow_entries.length : -1;
      },
      firstId,
    );
    expect(firstEntries.ok && firstEntries.value).toBe(1);

    const secondEntries = await registry.withAdmittedAnalysis(
      "binary_overview",
      undefined,
      async () => {
        const snapshot = registry.exportAnalysisSnapshot();
        return snapshot.ok ? snapshot.value.workflow_entries.length : -1;
      },
      secondId,
    );
    expect(secondEntries.ok && secondEntries.value).toBe(0);
  });
});
