import { describe, expect, it, vi } from "vitest";

import { AnalysisCancelledError } from "../../domain/analysisErrorCore.js";
import { err, ok as resultOk } from "../../domain/result.js";
import { observed } from "../../../tests/fixtures/analysisExecution.js";
import {
  createBinarySessionTargets,
  createDeferred,
  createTestBinaryTargetRegistry,
} from "../../../tests/fixtures/binarySession.js";

/**
 * A staged snapshot is read under the signal of the open that owns it.
 *
 * A background job belongs to the server, so the read follows the job's
 * signal. A cancelled request stops the wait for the job, not the job itself.
 */
describe("a background open that loads a staged snapshot", () => {
  it("reads the snapshot under the signal of the job", async () => {
    const [first] = await createBinarySessionTargets();
    const request = new AbortController();
    const signals: (AbortSignal | undefined)[] = [];
    const registry = createTestBinaryTargetRegistry(() => ({
      execute: () => Promise.resolve(observed(null)),
      close: () => Promise.resolve(resultOk(null)),
    }));

    const opened = await registry.open(first, {
      analysisMode: "background",
      signal: request.signal,
      loadSnapshot: async (signal) => {
        signals.push(signal);
        return err(new AnalysisCancelledError("open_binary"));
      },
    });
    expect(opened.ok).toBe(true);
    await vi.waitFor(() => expect(signals).toHaveLength(1));

    // The read follows the job, so a cancelled request does not stop it.
    expect(signals[0]).toBeDefined();
    expect(signals[0]).not.toBe(request.signal);
    request.abort();
    expect(signals[0]?.aborted).toBe(false);
  });

  it("keeps the job running when the request that waits for it is cancelled", async () => {
    const [first] = await createBinarySessionTargets();
    const request = new AbortController();
    const release = createDeferred<void>();
    const signals: (AbortSignal | undefined)[] = [];
    const registry = createTestBinaryTargetRegistry(() => ({
      execute: () => Promise.resolve(observed(null)),
      close: () => Promise.resolve(resultOk(null)),
    }));

    const opening = registry.open(first, {
      analysisMode: "auto",
      signal: request.signal,
      loadSnapshot: async (signal) => {
        signals.push(signal);
        // The read observes the signal of the open that owns it.
        await new Promise<void>((resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => reject(new Error("aborted")),
            {
              once: true,
            },
          );
          release.promise.then(resolve, reject);
        });
        return err(new AnalysisCancelledError("open_binary"));
      },
    });

    // The request is cancelled while the snapshot is loading.
    await vi.waitFor(() => expect(signals).toHaveLength(1));
    request.abort();
    const cancelled = await opening;
    expect(cancelled.ok).toBe(false);

    // The job the server owns is still running.
    expect(registry.analysisState()).toMatchObject({ state: "starting" });
    release.resolve();
  });
});
