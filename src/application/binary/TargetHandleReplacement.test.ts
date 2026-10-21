import { describe, expect, it, vi } from "vitest";

import { createAnalysisProfile } from "../../domain/analysisProfile.js";
import { AnalysisTargetNotOpenError } from "../../domain/analysisErrorCore.js";
import { ok as resultOk, type Result } from "../../domain/result.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type { AnalysisProfileResolution } from "../../application/AnalysisProvider.js";
import { observed } from "../../../tests/fixtures/analysisExecution.js";
import {
  createBinarySessionTargets,
  createDeferred,
  createTestBinaryTargetRegistry,
} from "../../../tests/fixtures/binarySession.js";

const profile = createAnalysisProfile(
  { id: "fixture", name: "Fixture analysis provider", version: "1" },
  { fixture: true },
);

/**
 * A handle names one live target.
 *
 * A foreground replacement resolves its target while the previous target is
 * still active, so a call that names the previous handle is admitted before
 * the replacement finishes. That call waits behind the replacement inside
 * the session, and it would run against the target that replaced the one it
 * named. The handle is therefore checked under the same admission that
 * protects the execution.
 */
describe("a handle that waits behind a replacement", () => {
  it("refuses the call instead of running it against the replacement", async () => {
    const [first, second] = await createBinarySessionTargets();
    const replacement =
      createDeferred<Result<AnalysisProfileResolution, AnalysisError>>();
    let resolutions = 0;
    const seen: string[] = [];
    const registry = createTestBinaryTargetRegistry(
      (target) => ({
        execute: (operation: string) => {
          if (operation !== "health") seen.push(target.sha256);
          return Promise.resolve(observed(operation));
        },
        close: () => Promise.resolve(resultOk(null)),
      }),
      {
        resolveAnalysisProfile: async () => {
          resolutions += 1;
          // The first open resolves its profile; the replacement waits.
          if (resolutions === 1) return resultOk({ profile });
          return replacement.promise;
        },
      },
    );

    expect((await registry.open(first)).ok).toBe(true);
    const handle = registry.currentTargetId();
    expect(handle).toBeDefined();

    // The replacement is resolving its target; the first target is active
    // and its handle still selects it.
    const opening = registry.open(second);
    await vi.waitFor(() => expect(resolutions).toBe(2));

    const call = registry.execute("address_name", {}, { targetId: handle! });

    replacement.resolve(resultOk({ profile }));
    expect((await opening).ok).toBe(true);

    const refused = await call;
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("expected a refused call");
    expect(refused.error).toBeInstanceOf(AnalysisTargetNotOpenError);
    expect(
      (refused.error as AnalysisTargetNotOpenError).requestedTargetId,
    ).toBe(handle);
    // The call never reached the replacement target.
    expect(seen).toEqual([]);
  });
});
