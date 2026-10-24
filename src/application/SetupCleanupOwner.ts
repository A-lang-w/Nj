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
  if (
    cause instanceof AnalysisError &&
    (cause.cleanupIncomplete ||
      cause.hasCleanupOwner ||
      cause.cleanup !== undefined ||
      cause instanceof ProviderCleanupError)
  )
    return cause;
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

/** One child callback and the conjunctive authorities reported by its generation. */
class SetupCleanupChild {
  #generation = {};
  #attempted: object | undefined;
  #completed: object | undefined;
  #report: AnalysisError | undefined;
  #reportedErrors = new WeakSet<AnalysisError>();
  #delegated: AnalysisError | undefined;
  #delegatedErrors = new WeakSet<AnalysisError>();
  #reason = "";
  #resources: readonly string[] = [];
  #attempt: ReturnType<SetupCleanupTask["close"]> = Promise.resolve();
  #lease = this.#newLease();

  constructor(private readonly task: SetupCleanupTask) {}

  admit(): void {
    this.#generation = {};
  }
  get hasNewGeneration(): boolean {
    return this.#attempted !== this.#generation;
  }

  get failure():
    | { readonly error: AnalysisError; readonly reason: string }
    | undefined {
    if (this.#report !== undefined && !this.#report.cleanupIncomplete) {
      this.#completed = this.#attempted;
      this.#report = undefined;
      this.#reportedErrors = new WeakSet();
    }
    return this.#report === undefined
      ? undefined
      : { error: this.#report, reason: this.#reason };
  }

  close(): Promise<void> {
    // A source owner may have completed between rejection and this retry.
    void this.failure;
    if (this.#completed === this.#generation) return Promise.resolve();
    if (this.#lease.released || this.#completed !== undefined) {
      this.#lease = this.#newLease();
      this.#completed = undefined;
      this.#delegated = undefined;
      this.#delegatedErrors = new WeakSet();
    }
    const generation = this.#generation;
    this.#attempted = generation;
    // Seal terminal child scopes before returning from close.
    try {
      this.#attempt = this.task.close();
    } catch (cause: unknown) {
      this.#attempt = Promise.reject(cause);
    }
    return this.#lease.release().then(() => {
      this.#completed = generation;
    });
  }

  #newLease(): AnalysisCleanupLease {
    return new AnalysisCleanupLease(() => this.#execute(), this);
  }

  get cleanupResources(): readonly string[] {
    return this.#resources;
  }

  async #execute(): Promise<void> {
    let failure: AnalysisError;
    try {
      const report = await this.#attempt;
      if (report === undefined) return;
      failure =
        report instanceof AnalysisError
          ? setupCleanupError(report)
          : setupCleanupError(
              undefined,
              typeof report === "string"
                ? { reason: report, resources: [] }
                : report,
            );
      this.#reason = setupCleanupReason(failure);
    } catch (cause: unknown) {
      failure = setupCleanupError(cause);
      this.#reason =
        (this.task.rejectedPrefix === undefined
          ? ""
          : this.task.rejectedPrefix + ": ") +
        (cause instanceof Error ? cause.message : String(cause));
    }
    if (!failure.hasCleanupOwner) {
      this.#resources = [...failure.cleanupResources];
      new AnalysisCleanupLeaseGroup(failure, [this.#lease]);
      this.#delegatedErrors.add(failure);
      // Every delegated report shares this exact lease. Retain one dependency
      // rather than retaining an error for every unsuccessful callback attempt.
      this.#delegated ??= failure;
    }
    const dependency = this.#delegatedErrors.has(failure)
      ? this.#delegated
      : failure;
    if (dependency !== undefined && dependency.cleanupIncomplete) {
      if (!this.#reportedErrors.has(dependency)) {
        if (this.#report === undefined || !this.#report.cleanupIncomplete) {
          this.#report = setupCleanupError(
            new AggregateError([dependency], "Setup child cleanup authorities"),
            { reason: this.#reason, resources: [] },
          );
          this.#reportedErrors = new WeakSet();
        } else this.#report.retainSecondaryFailure(dependency);
        this.#report.bindCleanupDependencies([dependency]);
        this.#reportedErrors.add(dependency);
      }
    }
    // A source's release cannot confirm an earlier delegated callback, and a
    // successful callback cannot release an independently owned source.
    if (failure.cleanupIncomplete) throw failure;
    if (this.#delegated?.cleanupIncomplete) throw this.#delegated;
  }
}

/** Preserve completed peers and follow live source errors through exact retries. */
export class SetupCleanupOwner {
  readonly #children: ReadonlyMap<SetupCleanupTask, SetupCleanupChild>;
  #closing: Promise<AnalysisError | undefined> | undefined;

  constructor(tasks: readonly SetupCleanupTask[]) {
    this.#children = new Map(
      tasks.map((task) => [task, new SetupCleanupChild(task)]),
    );
  }

  /** Admit actual new cleanup work, never merely another retry of a failed peer. */
  admit(task: SetupCleanupTask): void {
    const child = this.#children.get(task);
    if (child === undefined)
      throw new TypeError("Cleanup task is not owned by this setup host");
    child.admit();
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
    const children = [...this.#children.values()];
    // An active producer can admit its final cleanup outcome while draining.
    do {
      await Promise.allSettled(children.map((child) => child.close()));
    } while (children.some((child) => child.hasNewGeneration));
    const failures = children.flatMap((child) => {
      const failure = child.failure;
      return failure === undefined ? [] : [failure];
    });
    if (failures.length === 0) return undefined;
    const observation: AnalysisCleanupObservation = {
      reason: failures.map((failure) => failure.reason).join("; "),
      resources: [
        ...new Set(
          failures.flatMap((failure) => failure.error.cleanupResources),
        ),
      ],
    };
    const error = setupCleanupError(
      new AggregateError(
        failures.map((failure) => failure.error),
        "Setup child cleanup failures",
      ),
      observation,
    ).bindCleanupDependencies(failures.map((failure) => failure.error));
    return error.cleanupIncomplete ? error : undefined;
  }
}
