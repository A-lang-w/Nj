import type { ExecutionOptions } from "../application/AnalysisProvider.js";
import { AnalysisCleanupLease } from "../artifacts/AnalysisCleanupLease.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import { analysisErrorWithCleanupFailure } from "../domain/analysisErrorCleanup.js";
import { AnalysisCancelledError } from "../domain/analysisErrorCore.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { err, ok, type Result } from "../domain/result.js";
import type { IncludedScript } from "../domain/webBundleAnalyzerInspection.js";
import type { WebBundleScriptOutcome } from "../domain/webBundleScriptAnalysis.js";
import { prepareProcessOwnershipInspection } from "../process/ProcessOwnershipObservation.js";
import { ABORTED, waitForAbortable } from "../process/AbortablePromise.js";
import {
  OwnedWebBundleWorker,
  type WebBundleAnalysisWorkerDependencies,
  type WebBundleScriptAnalysisFailure,
} from "./WebBundleAnalysisWorker.js";

const OPERATION = "analyze_web_bundle";
const PROVIDER = "web-bundle-analysis";
type ScriptResult = Result<
  WebBundleScriptOutcome[],
  WebBundleScriptAnalysisFailure
>;

/** Analysis and cleanup share the browser provider's lifetime. */
export interface WebBundleScriptAnalyzer {
  analyze(
    scripts: readonly IncludedScript[],
    options: ExecutionOptions,
  ): Promise<ScriptResult>;
  close(): Promise<void>;
}

interface OwnedAnalysis {
  readonly worker: OwnedWebBundleWorker;
  readonly lease: AnalysisCleanupLease;
  active: boolean;
}

/** Own active requests and failed cleanup without borrowing another provider's resources. */
export class WebBundleAnalysisOwner implements WebBundleScriptAnalyzer {
  readonly #owned = new Set<OwnedAnalysis>();
  readonly #active = new Set<Promise<ScriptResult>>();
  readonly #shutdown = new AbortController();
  #tail: Promise<void> = Promise.resolve();
  #closePromise: Promise<void> | undefined;

  constructor(
    readonly dependencies: WebBundleAnalysisWorkerDependencies = {},
  ) {}

  analyze(
    scripts: readonly IncludedScript[],
    options: ExecutionOptions = {},
  ): Promise<ScriptResult> {
    const signal =
      options.signal === undefined
        ? this.#shutdown.signal
        : AbortSignal.any([options.signal, this.#shutdown.signal]);
    if (signal.aborted)
      return Promise.resolve(
        err({
          error: new AnalysisCancelledError(OPERATION, {
            cause: signal.reason,
          }),
        }),
      );
    if (scripts.length === 0 && this.#owned.size === 0)
      return Promise.resolve(ok([]));
    const worker = new OwnedWebBundleWorker(scripts, signal, this.dependencies);
    const record: OwnedAnalysis = {
      worker,
      active: true,
      lease: new AnalysisCleanupLease(
        async () => {
          const failure = await worker.close();
          if (failure !== undefined) throw failure;
        },
        {
          get cleanupResources() {
            return worker.cleanupResources;
          },
        },
      ),
    };
    this.#owned.add(record);
    const predecessor = this.#tail;
    // Register before preparation or acquisition can yield to provider shutdown.
    const running = Promise.resolve()
      .then(async () => {
        if (
          (await waitForAbortable(predecessor, signal)) === ABORTED ||
          signal.aborted
        ) {
          this.#owned.delete(record);
          return err({
            error: new AnalysisCancelledError(OPERATION, {
              cause: signal.reason,
            }),
          });
        }
        return this.#run(record, signal);
      })
      .finally(() => {
        record.active = false;
        this.#active.delete(running);
      });
    this.#active.add(running);
    // A cancelled waiter cannot let its successor overtake an active worker.
    this.#tail = Promise.allSettled([predecessor, running]).then(
      () => undefined,
    );
    return running;
  }

  async #run(
    record: OwnedAnalysis,
    signal: AbortSignal,
  ): Promise<ScriptResult> {
    let result: Result<WebBundleScriptOutcome[], AnalysisError>;
    try {
      try {
        await (
          this.dependencies.prepareOwnership ??
          prepareProcessOwnershipInspection
        )(signal);
      } catch (cause: unknown) {
        throw new ProviderAdapterError(PROVIDER, OPERATION, {
          cause,
          diagnostics: {
            error_message: message(cause),
            phase: "process_ownership_preparation",
          },
        });
      }
      const pending = await this.#retryPending();
      if (pending !== undefined) throw pending;
      result = ok(
        record.worker.scripts.length === 0 ? [] : await record.worker.run(),
      );
    } catch (cause: unknown) {
      result = err(record.worker.failure(cause));
    }
    const cleanup = await this.#release(record);
    const completed = result.ok ? { completed: result.value } : {};
    const outcome: ScriptResult = !result.ok
      ? err({ error: result.error })
      : signal.aborted
        ? err({
            error: new AnalysisCancelledError(OPERATION, {
              cause: signal.reason,
            }),
            ...completed,
          })
        : result;
    if (cleanup !== undefined)
      return err({
        error: outcome.ok
          ? cleanup
          : analysisErrorWithCleanupFailure(
              outcome.error.error,
              cleanup,
              OPERATION,
            ).bindCleanupDependencies([outcome.error.error, cleanup]),
        ...completed,
      });
    return outcome;
  }

  async #release(
    record: OwnedAnalysis,
  ): Promise<ProviderCleanupError | undefined> {
    try {
      await record.lease.release();
      this.#owned.delete(record);
      return undefined;
    } catch (cause: unknown) {
      const failure =
        cause instanceof ProviderCleanupError
          ? cause
          : new ProviderCleanupError(
              PROVIDER,
              record.worker.cleanupResources,
              { reason: message(cause) },
              { operation: OPERATION, cause },
            );
      record.lease.bindCleanupError(failure);
      return failure;
    }
  }

  async #retryPending(): Promise<ProviderCleanupError | undefined> {
    const failures: ProviderCleanupError[] = [];
    for (const record of this.#owned) {
      if (record.active) continue;
      const failure = await this.#release(record);
      if (failure !== undefined) failures.push(failure);
    }
    if (failures.length < 2) return failures[0];
    return new ProviderCleanupError(
      PROVIDER,
      failures.flatMap((failure) => failure.cleanupResources),
      {
        failures: failures.map((failure) => ({
          message: failure.message,
          diagnostics: failure.diagnostics ?? {},
        })),
      },
      {
        operation: OPERATION,
        cause: new AggregateError(
          failures,
          "Web bundle worker cleanup remains incomplete",
        ),
      },
    ).bindCleanupDependencies(failures);
  }

  /** Stop admission, cancel active work, await its cleanup, and retry every retained owner. */
  async close(): Promise<void> {
    this.#shutdown.abort(new Error("Browser provider is closing"));
    this.#closePromise ??= this.#closeAll().catch((cause: unknown) => {
      this.#closePromise = undefined;
      throw cause;
    });
    return this.#closePromise;
  }

  async #closeAll(): Promise<void> {
    await Promise.all(this.#active);
    const failure = await this.#retryPending();
    if (failure !== undefined) throw failure;
  }
}

const message = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);
