import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import type {
  AnalysisExecution,
  ExecutionOptions,
  FileCloseResourceOwner,
  ProviderAvailability,
} from "../application/AnalysisProvider.js";
import type { AndroidAnalysisPort } from "../application/android/AndroidAnalysisPort.js";
import {
  AnalysisCleanupLease,
  AnalysisCleanupLeaseGroup,
} from "../artifacts/AnalysisCleanupLease.js";
import {
  ArtifactResourceScope,
  ArtifactResourceRetryFailure,
} from "../artifacts/ArtifactResourceScope.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
  AnalysisInputError,
  AnalysisOutputError,
  AnalysisResourceConstraintError,
} from "../domain/analysisErrorCore.js";
import { analysisErrorWithCleanupFailure } from "../domain/analysisErrorCleanup.js";
import type { AndroidRequest } from "../domain/android/androidAnalysis.js";
import type { BinaryTarget } from "../domain/binaryTargetTypes.js";
import { jsonValueSchema, type JsonValue } from "../domain/jsonValue.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { err, ok, type Result } from "../domain/result.js";
import type { OwnedFileHandle } from "../filesystem/OwnedFileHandle.js";
import {
  RegularFileCleanupFailure,
  regularFileCancellation,
} from "../filesystem/OwnedRegularFile.js";
import { hashStableFile } from "../filesystem/StableFileHash.js";
import { ABORTED, waitForAbortable } from "../process/AbortablePromise.js";
import { runOwnedCommand } from "../process/OwnedCommand.js";
import { ProviderStartupDeadline } from "../process/ProviderDeadline.js";
import type { ProviderProcessSnapshot } from "../process/ProviderProcess.js";
import { retainOwnedCommandCleanup } from "../providers/OwnedCommandCleanup.js";
import { PROVIDER_REJECTION_CODES } from "../contracts/providerSelection.js";
import {
  resolveAscConfiguration,
  type AscConfiguration,
} from "./AscConfiguration.js";
import {
  ascExecutionFailure,
  ascInterruptionFailure,
  ascPartialObservation,
  capturedAscOutput,
  normalizeAscClassSearch,
  parseAscOutput,
  parseAscProbe,
} from "./AscProtocol.js";

type Launcher = NonNullable<Parameters<typeof runOwnedCommand>[2]>["launcher"];
const WORKER = fileURLToPath(
  new URL("../../bridge/android/rea_asc.py", import.meta.url),
);
/** Optional BYO ASC worker. No implicit dependency installation or JADX fallback. */
export class AscProvider implements AndroidAnalysisPort {
  readonly #resources = new ArtifactResourceScope();
  readonly #shutdown = new AbortController();
  readonly #fileLeases = new WeakMap<OwnedFileHandle, AnalysisCleanupLease>();
  #tail: Promise<void> = Promise.resolve();
  #closePromise: Promise<void> | undefined;
  readonly #resourceOwner: FileCloseResourceOwner = {
    retain: (owner, resource) =>
      this.#resources.retain({
        kind: "lease",
        resource,
        lease: AnalysisCleanupLease.forCloseOwner(owner, resource),
      }),
    run: (operation) => this.#resources.run(operation),
  };

  constructor(
    readonly environment: Readonly<
      Record<string, string | undefined>
    > = process.env,
    readonly launcher?: Launcher,
  ) {}

  /** Probe the explicit interpreter's actual ASC imports without opening an APK. */
  async inspectAvailability(
    signal?: AbortSignal,
  ): Promise<ProviderAvailability> {
    const operation = "inspect_asc_configuration";
    const inspected = await this.#serialize(
      operation,
      signal,
      async (active) => {
        const configuration = await resolveAscConfiguration(
          this.environment,
          operation,
        );
        return this.#withDeadline(
          configuration,
          operation,
          active,
          async (deadline) => {
            return this.#invoke(configuration, deadline, {
              operation,
              args: ["--operation", "probe"],
              interpret: (raw, snapshot) =>
                jsonValueSchema.parse({
                  python_executable: configuration.python,
                  provider: parseAscProbe(raw, snapshot, operation),
                  operation_timeout_ms: configuration.timeoutMs,
                }),
            });
          },
        );
      },
    );
    if (inspected.ok)
      return {
        status: "available",
        code: null,
        reason: null,
        diagnostics: inspected.value as Record<string, JsonValue>,
      };
    if (
      inspected.error instanceof AnalysisCancelledError ||
      inspected.error.cleanupIncomplete
    )
      throw inspected.error;
    return {
      status: "unavailable",
      code:
        PROVIDER_REJECTION_CODES.find(
          (code) =>
            code === inspected.error.diagnostics?.["asc_availability_code"],
        ) ?? "runtime_unavailable",
      reason: inspected.error.message,
      diagnostics: {
        ...inspected.error.diagnostics,
        failure_type: inspected.error._tag,
        remediation_action:
          inspected.error instanceof AnalysisCapabilityUnavailableError
            ? (inspected.error.remediationAction ?? null)
            : null,
      },
    };
  }

  execute(
    target: BinaryTarget,
    request: AndroidRequest,
    options?: ExecutionOptions,
  ): Promise<Result<AnalysisExecution, AnalysisError>> {
    return this.#serialize(
      request.operation,
      options?.signal,
      async (active) => {
        if (request.operation !== "search_android_classes")
          throw new AnalysisCapabilityUnavailableError(
            "asc",
            request.operation,
            "DroidASC currently supports only search_android_classes. Select JADX explicitly for package, member, source and incoming-reference operations.",
          );
        if (target.format !== "apk")
          throw new AnalysisCapabilityUnavailableError(
            "asc",
            request.operation,
            `Target ${target.path} is ${target.format}; select one standalone APK.`,
          );
        const configuration = await resolveAscConfiguration(
          this.environment,
          request.operation,
        );
        let raw: JsonValue | undefined;
        let completed: AnalysisExecution | undefined;
        try {
          return await this.#withDeadline(
            configuration,
            request.operation,
            active,
            async (deadline) => {
              if ((await stat(target.path)).size > configuration.maxApkBytes)
                throw new AnalysisResourceConstraintError(
                  request.operation,
                  "file-size",
                  "APK exceeds REA_ASC_MAX_APK_BYTES before ASC admission.",
                  { max_apk_bytes: configuration.maxApkBytes },
                  { retryable: false },
                );
              await this.#verifyTarget(
                target,
                request.operation,
                deadline.signal,
              );
              const executed = await this.#invoke(configuration, deadline, {
                operation: request.operation,
                args: [
                  "--apk",
                  target.path,
                  "--expected-sha256",
                  target.sha256,
                  "--operation",
                  "classes",
                  `--query-json=${JSON.stringify(request.input.query)}`,
                  "--max-apk-bytes",
                  String(configuration.maxApkBytes),
                  "--max-dex-bytes",
                  String(configuration.maxDexBytes),
                  "--max-output-bytes",
                  String(configuration.maxOutputBytes),
                ],
                interpret: (observed, snapshot) => {
                  raw = observed;
                  completed = normalizeAscClassSearch(
                    observed,
                    snapshot,
                    target,
                    request,
                  );
                  return completed;
                },
              });
              await this.#verifyTarget(
                target,
                request.operation,
                deadline.signal,
              );
              return executed;
            },
          );
        } catch (cause: unknown) {
          const failure =
            cause instanceof AnalysisError
              ? cause
              : new AnalysisOutputError(
                  request.operation,
                  "ASC response violated the worker protocol.",
                  { cause },
                );
          if (raw !== undefined)
            failure.retainPartialObservation(
              ascPartialObservation(target, request, raw, completed),
            );
          throw failure;
        }
      },
    );
  }

  /** Cancel active and queued requests; failed owners remain available for close retry. */
  close(): Promise<void> {
    this.#shutdown.abort();
    this.#closePromise ??= this.#tail
      .then(() => this.#resources.close())
      .catch((cause: unknown) => {
        this.#closePromise = undefined;
        throw this.#scopeFailure(cause, "close_binary");
      });
    return this.#closePromise;
  }

  async #serialize<T>(
    operation: string,
    signal: AbortSignal | undefined,
    work: (signal: AbortSignal) => Promise<T>,
  ): Promise<Result<T, AnalysisError>> {
    const active =
      signal === undefined
        ? this.#shutdown.signal
        : AbortSignal.any([signal, this.#shutdown.signal]);
    if (active.aborted)
      return err(
        new AnalysisCancelledError(operation, { cause: active.reason }),
      );
    const predecessor = this.#tail;
    let release = () => {};
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    if ((await waitForAbortable(predecessor, active)) === ABORTED) {
      void predecessor.then(release);
      return err(
        new AnalysisCancelledError(operation, { cause: active.reason }),
      );
    }
    try {
      return ok(
        await this.#resources.run(async () => {
          if (active.aborted)
            throw new AnalysisCancelledError(operation, {
              cause: active.reason,
            });
          return work(active);
        }),
      );
    } catch (cause: unknown) {
      return err(this.#scopeFailure(cause, operation));
    } finally {
      release();
    }
  }

  async #withDeadline<T>(
    configuration: AscConfiguration,
    operation: string,
    signal: AbortSignal,
    work: (deadline: ProviderStartupDeadline) => Promise<T>,
  ): Promise<T> {
    const deadline = new ProviderStartupDeadline(
      configuration.timeoutMs,
      signal,
    );
    try {
      const result = await work(deadline);
      if (deadline.signal.aborted)
        throw new AnalysisCancelledError(operation, {
          cause: deadline.signal.reason,
        });
      return result;
    } catch (cause: unknown) {
      throw this.#failure(cause, operation, configuration, deadline);
    } finally {
      deadline.dispose();
    }
  }

  async #invoke<T>(
    configuration: AscConfiguration,
    deadline: ProviderStartupDeadline,
    invocation: {
      readonly operation: string;
      readonly args: readonly string[];
      readonly interpret: (
        raw: JsonValue,
        snapshot: ProviderProcessSnapshot,
      ) => T;
    },
  ): Promise<T> {
    const { operation } = invocation;
    let observation:
      | { readonly kind: "completed"; readonly value: T }
      | { readonly kind: "failed"; readonly error: AnalysisError }
      | undefined;
    try {
      await runOwnedCommand(
        {
          command: configuration.python,
          arguments: ["-B", WORKER, ...invocation.args],
          runId: randomUUID(),
          hostEnvironment: this.environment,
        },
        {
          timeoutMs: Math.max(1, deadline.remainingMs()),
          diagnosticBytes: configuration.maxOutputBytes,
          acceptNonZeroExit: true,
          observeCompleted: (snapshot) => {
            // Semantic consumption belongs before final cleanup: an invalid identity
            // remains the primary failure if cancellation arrives during owner stop.
            try {
              const raw = parseAscOutput(snapshot, operation);
              observation = {
                kind: "completed",
                value: invocation.interpret(raw, snapshot),
              };
            } catch (cause: unknown) {
              const error = this.#failure(
                cause,
                operation,
                configuration,
                deadline,
              );
              observation = {
                kind: "failed",
                error:
                  error instanceof AnalysisOutputError &&
                  error.capturedOutput === undefined
                    ? new AnalysisOutputError(operation, error.reason, {
                        cause: error,
                        capturedOutput: capturedAscOutput(snapshot),
                      })
                    : error,
              };
            }
          },
        },
        {
          signal: deadline.signal,
          ...(this.launcher === undefined ? {} : { launcher: this.launcher }),
        },
      );
    } catch (cause: unknown) {
      let failure = this.#failure(cause, operation, configuration, deadline);
      for (const cleanup of retainOwnedCommandCleanup(
        cause,
        this.#resourceOwner,
        "asc",
        operation,
      ))
        failure = analysisErrorWithCleanupFailure(
          failure,
          cleanup,
          operation,
        ).bindCleanupDependencies([failure, cleanup]);
      if (observation?.kind === "failed") {
        const primary = observation.error;
        throw failure.cleanupIncomplete
          ? analysisErrorWithCleanupFailure(
              primary,
              failure,
              operation,
            ).bindCleanupDependencies([primary, failure])
          : primary.retainSecondaryFailure(failure);
      }
      throw failure;
    }
    if (observation === undefined)
      throw new AnalysisOutputError(
        operation,
        "ASC output closure did not yield a completed observation.",
      );
    if (observation.kind === "failed") throw observation.error;
    return observation.value;
  }

  async #verifyTarget(
    target: BinaryTarget,
    operation: string,
    signal: AbortSignal,
  ): Promise<void> {
    const hashed = await hashStableFile(target.path, {
      signal,
      retainFailedClose: (owner) => {
        const lease = AnalysisCleanupLease.forCloseOwner(owner, target.path);
        this.#fileLeases.set(owner, lease);
        this.#resources.retain({ kind: "lease", resource: target.path, lease });
      },
    });
    if (hashed.sha256 !== target.sha256)
      throw new AnalysisInputError(operation, undefined, [
        {
          path: ["path"],
          reason: "invalid_value",
          message: `APK bytes changed after admission at ${target.path}; retry with a stable file.`,
        },
      ]);
  }

  #failure(
    cause: unknown,
    operation: string,
    configuration: AscConfiguration,
    deadline: ProviderStartupDeadline,
  ): AnalysisError {
    const context = {
      operation,
      timeoutMs: configuration.timeoutMs,
      maxOutputBytes: configuration.maxOutputBytes,
      signal: deadline.signal,
      interruption: deadline.interruption,
    };
    if (!(cause instanceof RegularFileCleanupFailure))
      return ascExecutionFailure(cause, context);
    const cancellation = regularFileCancellation(cause);
    const primary =
      cancellation !== undefined
        ? ascInterruptionFailure(cancellation.reason, context)
        : cause.outcome.kind === "failed"
          ? ascExecutionFailure(cause.outcome.cause, context)
          : new ProviderAdapterError("asc", operation, { cause });
    const cleanup = new ProviderCleanupError(
      "asc",
      [cause.path],
      { reason: String(cause.cleanupCause) },
      { operation, cause },
    );
    const lease = this.#fileLeases.get(cause.owner);
    if (lease !== undefined) new AnalysisCleanupLeaseGroup(cleanup, [lease]);
    return analysisErrorWithCleanupFailure(
      primary,
      cleanup,
      operation,
    ).bindCleanupDependencies([primary, cleanup]);
  }

  #scopeFailure(cause: unknown, operation: string): AnalysisError {
    if (cause instanceof AnalysisError) return cause;
    if (cause instanceof ArtifactResourceRetryFailure) {
      const failure = new ProviderCleanupError(
        "asc",
        cause.cleanup?.resources ?? this.#resources.cleanupResources,
        { reason: cause.message },
        { operation, cause },
      );
      new AnalysisCleanupLeaseGroup(failure, cause.cleanupLeases);
      return failure;
    }
    return new ProviderAdapterError("asc", operation, { cause });
  }
}
