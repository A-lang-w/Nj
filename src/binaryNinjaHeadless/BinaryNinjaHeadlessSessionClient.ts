import type { Logger } from "pino";
import { z } from "zod";

import {
  createAnalysisExecution,
  type AnalysisClient,
  type AnalysisExecution,
  type AnalysisOperation,
  type ExecutionOptions,
} from "../application/AnalysisProvider.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  AnalysisArtifactChangedError,
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
  AnalysisOutputError,
  AnalysisResourceConstraintError,
  AnalysisTimeoutError,
  AnalysisUnsupportedTargetError,
} from "../domain/analysisErrorCore.js";
import type { AnalysisProfileCommitment } from "../domain/analysisProfile.js";
import type { BinaryTarget } from "../domain/binaryTargetTypes.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { err, ok, type Result } from "../domain/result.js";
import { ProviderStartupDeadline } from "../process/ProviderDeadline.js";
import {
  BinaryNinjaBridgeProcessError,
  BinaryNinjaBridgeRequestError,
  BinaryNinjaHeadlessBridgeProcess,
  type BinaryNinjaHeadlessLauncher,
} from "./BinaryNinjaHeadlessBridgeProcess.js";
import type { AvailableBinaryNinjaHeadlessInstallation } from "./BinaryNinjaHeadlessInstallation.js";
import {
  BinaryNinjaHeadlessOperationRunner,
  binaryNinjaRequestFailure,
  parseBinaryNinjaHeadlessInput,
  type BinaryNinjaOperationOutcome,
  type BinaryNinjaRegexOptions,
} from "./BinaryNinjaHeadlessOperationRunner.js";
import {
  bridgeHealthSchema,
  bridgeOverviewSchema,
  type BinaryNinjaBridgeOverview,
  type BinaryNinjaBridgeReadyFrame,
} from "./BinaryNinjaHeadlessProtocolValues.js";
import {
  BINARY_NINJA_HEADLESS_PROVIDER_IDENTITY,
  binaryNinjaHeadlessLimitationsFor,
  isBinaryNinjaHeadlessOperation,
} from "./BinaryNinjaHeadlessProviderCapabilities.js";

const PROVIDER_ID = BINARY_NINJA_HEADLESS_PROVIDER_IDENTITY.id;
const STARTUP_TIMEOUT_SETTING = "REA_BINARY_NINJA_STARTUP_TIMEOUT_MS";
const RECOVERY =
  "Check BINARY_NINJA_INSTALL_DIR, REA_BINARY_NINJA_PYTHON and the Binary Ninja license, then retry; see docs/binaryninja-headless-provider.md.";

/** Environment the owned interpreter receives on top of the snapshot host environment. */
export const BINARY_NINJA_BRIDGE_ENVIRONMENT: Readonly<NodeJS.ProcessEnv> =
  Object.freeze({
    BN_DISABLE_USER_PLUGINS: "1",
    BN_DISABLE_REPOSITORY_PLUGINS: "1",
    BN_DISABLE_USER_SETTINGS: "1",
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONUTF8: "1",
    PYTHONIOENCODING: "utf-8",
  });

/** Interpreter arguments: isolated mode, unbuffered stdio, then the bridge script. */
export const binaryNinjaBridgeArguments = (
  bridgeScriptPath: string,
  apiDir: string,
): readonly string[] => ["-I", "-u", bridgeScriptPath, "--api-dir", apiDir];

export interface BinaryNinjaHeadlessSessionClientOptions extends BinaryNinjaRegexOptions {
  readonly target: BinaryTarget;
  readonly profile?: AnalysisProfileCommitment | undefined;
  readonly installation: AvailableBinaryNinjaHeadlessInstallation;
  readonly bridgeScriptPath: string;
  readonly startupTimeoutMs: number;
  readonly hostEnvironment: Readonly<NodeJS.ProcessEnv>;
  readonly platform?: NodeJS.Platform | undefined;
  readonly runId?: string | undefined;
  readonly launcher?: BinaryNinjaHeadlessLauncher | undefined;
  /** Largest single bridge reply admitted; omitted keeps the 64 MiB default. */
  readonly maxReplyBytes?: number | undefined;
  readonly logger?: Logger | undefined;
}

interface StartedBridge {
  readonly bridge: BinaryNinjaHeadlessBridgeProcess;
  readonly ready: BinaryNinjaBridgeReadyFrame;
  readonly overview: BinaryNinjaBridgeOverview;
  readonly runner: BinaryNinjaHeadlessOperationRunner;
}

const wasCancelled = (options: ExecutionOptions | undefined): boolean =>
  options?.signal?.aborted === true;

/**
 * Serial session over one owned headless Binary Ninja interpreter.
 *
 * The interpreter starts on the first request and is replaced after it fails;
 * a failed start is never cached. Close asks it to release the view and then
 * stops the owned process.
 */
export class BinaryNinjaHeadlessSessionClient implements AnalysisClient {
  readonly #options: BinaryNinjaHeadlessSessionClientOptions;
  #tail: Promise<void> = Promise.resolve();
  #startup: Promise<StartedBridge> | undefined;
  #started: StartedBridge | undefined;
  #closing = false;
  #closePromise: Promise<Result<null, AnalysisError>> | undefined;

  constructor(options: BinaryNinjaHeadlessSessionClientOptions) {
    this.#options = options;
  }

  execute(
    operation: AnalysisOperation,
    parameters: Readonly<Record<string, JsonValue>>,
    options?: ExecutionOptions,
  ): Promise<Result<AnalysisExecution, AnalysisError>> {
    const call = this.#tail.then(() =>
      this.#execute(operation, parameters, options),
    );
    this.#tail = call.then(
      () => undefined,
      () => undefined,
    );
    return call;
  }

  async #execute(
    operation: AnalysisOperation,
    parameters: Readonly<Record<string, JsonValue>>,
    options?: ExecutionOptions,
  ): Promise<Result<AnalysisExecution, AnalysisError>> {
    if (this.#closing)
      return err(
        new ProviderAdapterError(PROVIDER_ID, operation, {
          diagnostics: { reason: "client_closed" },
        }),
      );
    if (wasCancelled(options))
      return err(
        new AnalysisCancelledError(operation, {
          cause: options?.signal?.reason,
        }),
      );
    if (operation !== "health" && !isBinaryNinjaHeadlessOperation(operation))
      return err(
        new AnalysisCapabilityUnavailableError(
          PROVIDER_ID,
          operation,
          "This adapter serves read-only headless Binary Ninja analysis operations only.",
        ),
      );
    let admitted = parameters;
    if (operation !== "health") {
      const parsed = parseBinaryNinjaHeadlessInput(
        operation,
        parameters,
        this.#options.target,
      );
      if (!parsed.ok) return parsed;
      admitted = parsed.value;
    }
    try {
      const started = await this.#start(operation, options);
      const outcome =
        operation === "health"
          ? await this.#health(started, options)
          : await started.runner.run(operation, admitted, options);
      return ok(this.#execution(operation, started, outcome));
    } catch (cause: unknown) {
      return err(this.#failure(operation, cause, options));
    }
  }

  #execution(
    operation: AnalysisOperation,
    started: StartedBridge,
    outcome: BinaryNinjaOperationOutcome,
  ): AnalysisExecution {
    return createAnalysisExecution(
      outcome.result,
      BINARY_NINJA_HEADLESS_PROVIDER_IDENTITY,
      {
        ...(outcome.rawResult === undefined
          ? {}
          : {
              rawResult: {
                engine: this.#engineFacts(started),
                bridge: outcome.rawResult,
              },
            }),
        limitations: [
          ...binaryNinjaHeadlessLimitationsFor(operation),
          ...(outcome.limitations ?? []),
        ],
        locations: [
          { kind: "artifact-path", path: this.#options.target.path },
          ...(outcome.locations ?? []),
        ],
        ...(outcome.relationshipCoverage === undefined
          ? {}
          : { relationshipCoverage: outcome.relationshipCoverage }),
        ...(this.#options.profile === undefined
          ? {}
          : { analysisProfile: this.#options.profile }),
      },
    );
  }

  #engineFacts(started: StartedBridge): JsonValue {
    return {
      core_version: started.ready.core_version,
      build_id: started.ready.build_id,
      product_type: started.ready.product_type,
      python_version: started.ready.python_version,
      user_plugins_disabled: started.ready.user_plugins_disabled,
      user_settings_disabled: started.ready.user_settings_disabled,
      view_type: started.overview.view_type,
      architecture: started.overview.architecture,
      platform: started.overview.platform,
    };
  }

  async #health(
    started: StartedBridge,
    options?: ExecutionOptions,
  ): Promise<BinaryNinjaOperationOutcome> {
    const health = bridgeHealthSchema.parse(
      await started.bridge.request("health", {}, options?.signal),
    );
    return {
      result: {
        ready: health.open,
        engine: this.#engineFacts(started),
        analysis_state: health.analysis_state ?? null,
        path: this.#options.target.path,
        entry_point: started.overview.entry_point,
        function_count: started.overview.function_count,
        string_count: started.overview.string_count,
        load_and_analysis_ms: started.overview.load_and_analysis_ms ?? null,
      },
    };
  }

  // -- startup ---------------------------------------------------------------

  async #start(
    operation: string,
    options?: ExecutionOptions,
  ): Promise<StartedBridge> {
    if (this.#started !== undefined && !this.#started.bridge.failed)
      return this.#started;
    // A retired interpreter is replaced; its failure is not cached.
    this.#started = undefined;
    this.#startup ??= this.#startBridge(operation, options?.signal);
    try {
      this.#started = await this.#startup;
      return this.#started;
    } finally {
      this.#startup = undefined;
    }
  }

  async #startBridge(
    operation: string,
    signal?: AbortSignal,
  ): Promise<StartedBridge> {
    const { installation, target } = this.#options;
    const deadline = new ProviderStartupDeadline(
      this.#options.startupTimeoutMs,
      signal,
    );
    const bridge = new BinaryNinjaHeadlessBridgeProcess({
      command: installation.pythonPath,
      arguments: binaryNinjaBridgeArguments(
        this.#options.bridgeScriptPath,
        installation.apiDir,
      ),
      env: BINARY_NINJA_BRIDGE_ENVIRONMENT,
      hostEnvironment: this.#options.hostEnvironment,
      platform: this.#options.platform,
      runId: this.#options.runId,
      launcher: this.#options.launcher,
      maxReplyBytes: this.#options.maxReplyBytes,
      onDiagnostic: (event) => {
        if (event.type === "error")
          this.#options.logger?.warn(
            { event: event.message },
            "Binary Ninja bridge process reported an error",
          );
      },
    });
    try {
      const ready = await bridge.start(deadline.signal);
      const overview = bridgeOverviewSchema.parse(
        await bridge.request(
          "open",
          { path: target.path, sha256: target.sha256, format: target.format },
          deadline.signal,
        ),
      );
      this.#options.logger?.info(
        {
          core_version: ready.core_version,
          load_and_analysis_ms: overview.load_and_analysis_ms ?? null,
          function_count: overview.function_count,
        },
        "Binary Ninja headless analysis completed",
      );
      return {
        bridge,
        ready,
        overview,
        runner: new BinaryNinjaHeadlessOperationRunner(bridge, target, {
          regexMatchingDeadline: this.#options.regexMatchingDeadline,
          regexWorkerHeapRequest: this.#options.regexWorkerHeapRequest,
        }),
      };
    } catch (cause: unknown) {
      await bridge.stop();
      throw this.#startupFailure(operation, cause, deadline, bridge);
    } finally {
      deadline.dispose();
    }
  }

  #startupFailure(
    operation: string,
    cause: unknown,
    deadline: ProviderStartupDeadline,
    bridge: BinaryNinjaHeadlessBridgeProcess,
  ): AnalysisError {
    const capturedOutput = bridge.diagnostics();
    const context = capturedOutput === undefined ? {} : { capturedOutput };
    if (deadline.interruption === "timeout")
      return new AnalysisTimeoutError(
        operation,
        this.#options.startupTimeoutMs,
        {
          cause,
          ...context,
          userMessage: `Binary Ninja did not finish importing its API, loading the target and completing analysis within ${String(this.#options.startupTimeoutMs)} ms.`,
          remediationAction: `Raise ${STARTUP_TIMEOUT_SETTING} for large targets, then retry.`,
        },
      );
    if (deadline.interruption === "cancelled")
      return new AnalysisCancelledError(operation, {
        cause: deadline.signal.reason,
        ...context,
      });
    const { target } = this.#options;
    if (cause instanceof BinaryNinjaBridgeRequestError) {
      if (cause.code === "digest_mismatch")
        return new AnalysisArtifactChangedError(
          operation,
          target.path,
          cause.message,
          { cause, diagnostics: cause.details, ...context },
        );
      if (
        cause.code === "view_type_mismatch" ||
        cause.code === "unsupported_format"
      )
        return new AnalysisUnsupportedTargetError(
          operation,
          target.path,
          cause.message,
          { cause, diagnostics: cause.details, ...context },
        );
      return new ProviderAdapterError(PROVIDER_ID, operation, {
        cause,
        ...context,
        userMessage: `${cause.message}. ${RECOVERY}`,
        diagnostics: {
          startup_operation: "open",
          bridge_code: cause.code,
          bridge_details: cause.details,
        },
      });
    }
    if (cause instanceof BinaryNinjaBridgeProcessError)
      return new ProviderAdapterError(PROVIDER_ID, operation, {
        cause,
        ...context,
        userMessage:
          cause.stage === "startup"
            ? `The Binary Ninja Python API could not be imported by ${this.#options.installation.pythonPath}: ${cause.message}. ${RECOVERY}`
            : `${cause.message}. ${RECOVERY}`,
        diagnostics: {
          startup_operation: cause.stage,
          ...(cause.code === undefined ? {} : { bridge_code: cause.code }),
        },
      });
    if (cause instanceof AnalysisError) return cause;
    return new ProviderAdapterError(PROVIDER_ID, operation, {
      cause,
      ...context,
      diagnostics: {
        startup_operation: "start",
        reason: cause instanceof Error ? cause.message : String(cause),
      },
    });
  }

  // -- failures --------------------------------------------------------------

  #failure(
    operation: string,
    cause: unknown,
    options: ExecutionOptions | undefined,
  ): AnalysisError {
    if (cause instanceof AnalysisError) return cause;
    if (wasCancelled(options))
      return new AnalysisCancelledError(operation, { cause });
    if (cause instanceof BinaryNinjaBridgeRequestError)
      return binaryNinjaRequestFailure(operation, cause, options);
    if (cause instanceof BinaryNinjaBridgeProcessError) {
      const context =
        cause.diagnostics === undefined
          ? {}
          : { capturedOutput: cause.diagnostics };
      if (cause.stage === "resource")
        return new AnalysisResourceConstraintError(
          operation,
          "capacity",
          cause.message,
          null,
          { cause, ...context },
        );
      return new ProviderAdapterError(PROVIDER_ID, operation, {
        cause,
        ...context,
        userMessage: `${cause.message}. The owned Binary Ninja interpreter is restarted by the next request.`,
        diagnostics: { bridge_stage: cause.stage },
      });
    }
    if (cause instanceof z.ZodError)
      return new AnalysisOutputError(
        operation,
        `Binary Ninja bridge returned malformed producer data: ${cause.issues
          .map((issue) => `${issue.path.join(".") || "$"}: ${issue.message}`)
          .join("; ")}`,
        { cause },
      );
    return new ProviderAdapterError(PROVIDER_ID, operation, {
      cause,
      diagnostics: {
        reason: cause instanceof Error ? cause.message : String(cause),
      },
    });
  }

  // -- lifecycle -------------------------------------------------------------

  close(): Promise<Result<null, AnalysisError>> {
    this.#closePromise ??= this.#closeOnce();
    return this.#closePromise;
  }

  async #closeOnce(): Promise<Result<null, AnalysisError>> {
    this.#closing = true;
    await this.#tail;
    if (this.#startup !== undefined)
      await this.#startup.then(
        () => undefined,
        () => undefined,
      );
    const started = this.#started;
    this.#started = undefined;
    if (started === undefined) return ok(null);
    if (!started.bridge.failed)
      // Ask the interpreter to release its view; the stop below is authoritative.
      await started.bridge
        .request("close", {}, AbortSignal.timeout(5_000))
        .catch(() => undefined);
    const stopped = await started.bridge.stop();
    if (stopped.status !== "incomplete") return ok(null);
    return err(
      new ProviderCleanupError(
        PROVIDER_ID,
        [`binary-ninja-bridge:${started.bridge.runId}`],
        {
          reason: stopped.reason,
          stderr: started.bridge.diagnostics()?.stderr ?? "",
        },
        { operation: "close_binary" },
      ),
    );
  }
}
