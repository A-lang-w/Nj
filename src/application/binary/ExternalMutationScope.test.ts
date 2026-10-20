import { describe, expect, it } from "vitest";

import { AnalysisOutputError } from "../../domain/analysisErrorCore.js";
import { createAnalysisProfile } from "../../domain/analysisProfile.js";
import { ok as resultOk } from "../../domain/result.js";
import { observed } from "../../../tests/fixtures/analysisExecution.js";
import {
  createBinarySessionTargets,
  createTestBinaryTargetRegistry,
} from "../../../tests/fixtures/binarySession.js";
import { BinaryTargetRegistry } from "./BinaryTargetRegistry.js";
import { AnalysisProviderRegistry } from "./AnalysisProviderRegistry.js";
import { SessionProviderRouter } from "./SessionProviderRouter.js";
import { InvestigationRecords } from "../investigation/InvestigationRecords.js";
import type {
  AnalysisOperation,
  AnalysisProviderCandidate,
} from "../AnalysisProvider.js";

/**
 * An external mutation may write any artifact, so the rules that protect the
 * analysis apply to every open session, not only to the current one. A
 * session that is not current must not keep analysis of bytes that may have
 * changed, and a Ghidra session must not slip past the explicit close.
 */
describe("an external mutation with several open targets", () => {
  it("retires every open session, not only the current one", async () => {
    const [first, second] = await createBinarySessionTargets();
    const registry = createTestBinaryTargetRegistry(() => ({
      execute: () => Promise.resolve(observed(null)),
      close: () => Promise.resolve(resultOk(null)),
    }));

    expect((await registry.open(first, { keepOthersOpen: true })).ok).toBe(
      true,
    );
    const firstId = registry.currentTargetId();
    expect((await registry.open(second, { keepOthersOpen: true })).ok).toBe(
      true,
    );
    const secondId = registry.currentTargetId();

    const mutated = await registry.withAdmittedExternalMutation(
      undefined,
      undefined,
      async () => resultOk(null),
      () =>
        new AnalysisOutputError(
          "execute_rizin_command",
          "the analysis session could not be retired",
        ),
    );

    expect(mutated.ok).toBe(true);
    // Neither session keeps analysis of bytes the command may have changed.
    expect(registry.activeTarget(firstId)).toBeUndefined();
    expect(registry.activeTarget(secondId)).toBeUndefined();
    expect(registry.targets()).toHaveLength(0);
  });

  it("refuses the mutation while a Ghidra session is open in another slot", async () => {
    const [first, second] = await createBinarySessionTargets();
    const registry = createTestSelectableRegistry();

    expect(
      (
        await registry.open(first, {
          keepOthersOpen: true,
          providerId: "ghidra",
        })
      ).ok,
    ).toBe(true);
    const firstId = registry.currentTargetId();
    expect(
      (
        await registry.open(second, {
          keepOthersOpen: true,
          providerId: "other",
        })
      ).ok,
    ).toBe(true);
    // The current session is not the Ghidra one.
    expect(registry.currentTargetId()).not.toBe(firstId);
    expect(registry.providerIdentity(undefined, firstId!).id).toBe("ghidra");
    expect(registry.providerIdentity().id).toBe("other");

    let ran = false;
    const refused = await registry.withAdmittedExternalMutation(
      undefined,
      undefined,
      async () => {
        ran = true;
        return resultOk(null);
      },
      () =>
        new AnalysisOutputError(
          "execute_rizin_command",
          "the analysis session could not be retired",
        ),
    );

    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error).toBeInstanceOf(AnalysisOutputError);
    // The command never ran, so the Ghidra session kept its edits.
    expect(ran).toBe(false);
    expect(registry.activeTarget(firstId)).toBeDefined();
  });
});

/**
 * A registry with two selectable providers, so one session binds the Ghidra
 * provider and another binds a different one.
 */
const createTestSelectableRegistry = (): BinaryTargetRegistry =>
  new BinaryTargetRegistry(
    SessionProviderRouter.selectable(
      new AnalysisProviderRegistry([
        selectableCandidate("ghidra", "address_name"),
        selectableCandidate("other", "procedure_info"),
      ]),
      [],
    ),
    new InvestigationRecords(),
  );

const selectableCandidate = (
  id: string,
  operation: Exclude<AnalysisOperation, "health">,
): AnalysisProviderCandidate => {
  const identity = { id, name: id, version: "1" };
  return {
    identity: () => identity,
    capabilities: () => [
      {
        provider: identity,
        operation,
        available: true,
        reason: null,
        cachePolicy: "live",
        effects: {
          mutatesArtifact: false,
          launchesProcess: false,
          mayShowUi: false,
          mayAccessNetwork: false,
          mayWriteFilesystem: false,
          changesPermissions: false,
          requiresRoot: false,
        },
        limitations: [],
      },
    ],
    createClient: () => ({
      execute: () => Promise.resolve(observed(null)),
      close: () => Promise.resolve(resultOk(null)),
    }),
    resolveAnalysisProfile: () =>
      Promise.resolve(
        resultOk({
          profile: createAnalysisProfile(identity, { fixture: true }),
        }),
      ),
    inspectAvailability: () => ({
      status: "available",
      code: null,
      reason: null,
      diagnostics: {},
    }),
    inspectTargetSupport: () => ({
      status: "supported",
      code: null,
      reason: null,
      diagnostics: {},
    }),
  };
};
