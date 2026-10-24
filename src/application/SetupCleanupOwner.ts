import {
  AnalysisCleanupLease,
  AnalysisCleanupLeaseGroup,
} from "../artifacts/AnalysisCleanupLease.js";
import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import {
  AnalysisError,
  type AnalysisCleanupObservation,
} from "../domain/analysisErrorBase.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { bindRegularFileCleanup } from "./RegularFileRead.js";

interface SetupCleanupTask {
  readonly rejectedPrefix?: string;
  close(): Promise<string | AnalysisCleanupObservation | AnalysisError | void>;
}

/** Preserve explicit cleanup capabilities when a host rejects instead of reporting. */
export const setupCleanupError = (
  cause: unknown,
  observation = ArtifactReaderFailure.cleanupObservation(cause, []),
): AnalysisError => {
  if (cause instanceof AnalysisError && cause.cleanupIncomplete) return cause;
  const error = new ProviderCleanupError(
    "setup",
    observation.resources,
    { reason: observation.reason },
    { cause, cleanup: observation, operation: "setup" },
  );
  bindRegularFileCleanup(cause, error);
  return error;
};

export const setupCleanupReason = (error: AnalysisError): string =>
  error.cleanup?.reason ??
  (typeof error.diagnostics?.reason === "string"
    ? error.diagnostics.reason
    : error.message);

/** Own each child close until its exact retry confirms release. */
export class SetupCleanupOwner {
  readonly #entries: readonly {
    readonly lease: AnalysisCleanupLease;
    readonly close: () => Promise<void>;
    readonly reason: () => string;
  }[];
  #closing: Promise<AnalysisError | undefined> | undefined;

  constructor(tasks: readonly SetupCleanupTask[]) {
    this.#entries = tasks.map((task) => {
      let failure: AnalysisError | undefined;
      let reason = "";
      let attempt: ReturnType<SetupCleanupTask["close"]> = Promise.resolve();
      const execute = async () => {
        try {
          const report = await attempt;
          failure =
            report === undefined
              ? undefined
              : report instanceof AnalysisError
                ? setupCleanupError(report)
                : setupCleanupError(
                    undefined,
                    typeof report === "string"
                      ? { reason: report, resources: [] }
                      : report,
                  );
          reason = failure === undefined ? "" : setupCleanupReason(failure);
        } catch (cause: unknown) {
          failure = setupCleanupError(cause);
          reason =
            (task.rejectedPrefix === undefined
              ? ""
              : task.rejectedPrefix + ": ") +
            (cause instanceof Error ? cause.message : String(cause));
        }
        if (failure !== undefined) throw failure;
      };
      const resources = {
        get cleanupResources() {
          return failure?.cleanupResources ?? [];
        },
      };
      let lease = new AnalysisCleanupLease(execute, resources);
      return {
        get lease() {
          return lease;
        },
        reason: () => reason,
        close: () => {
          // A completed generation cannot hide later child cleanup work.
          if (lease.released)
            lease = new AnalysisCleanupLease(execute, resources);
          // Seal terminal child scopes before returning from close.
          try {
            attempt = task.close();
          } catch (cause: unknown) {
            attempt = Promise.reject(cause);
          }
          return lease.release();
        },
      };
    });
  }

  close(): Promise<AnalysisError | undefined> {
    if (this.#closing !== undefined) return this.#closing;
    const attempt = this.#attempt().finally(() => {
      if (this.#closing === attempt) this.#closing = undefined;
    });
    this.#closing = attempt;
    return attempt;
  }

  async #attempt(): Promise<AnalysisError | undefined> {
    const outcomes = await Promise.allSettled(
      this.#entries.map((entry) => entry.close()),
    );
    const failed = this.#entries.filter(
      (_, index) => outcomes[index]?.status === "rejected",
    );
    if (failed.length === 0) return undefined;
    const observation: AnalysisCleanupObservation = {
      reason: failed.map((entry) => entry.reason()).join("; "),
      resources: [
        ...new Set(failed.flatMap(({ lease }) => lease.cleanupResources ?? [])),
      ],
    };
    const error = setupCleanupError(undefined, observation);
    new AnalysisCleanupLeaseGroup(
      error,
      failed.map(({ lease }) => lease),
    );
    return error;
  }
}
