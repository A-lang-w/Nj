import { createHash, randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import type { ExecutionOptions } from "../application/AnalysisProvider.js";
import { readStableArtifact } from "../artifacts/readStableArtifact.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
  AnalysisOutputError,
  AnalysisTimeoutError,
} from "../domain/analysisErrorCore.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { err, ok, type Result } from "../domain/result.js";
import type { IncludedScript } from "../domain/webBundleAnalyzerInspection.js";
import {
  webBundleScriptFactsSchema,
  type WebBundleScriptOutcome,
} from "../domain/webBundleScriptAnalysis.js";
import { javaScriptWorkerMemoryLimitBytes } from "../process/JavaScriptWorkerMemoryLimit.js";
import { cleanupOwnedProcessGroup } from "../process/ProcessOwnership.js";
import { prepareProcessOwnershipInspection } from "../process/ProcessOwnershipObservation.js";
import { PrivateRuntimeRoot } from "../process/PrivateRuntimeRoot.js";
import { PrivateRuntimeRootUnavailableError } from "../process/PrivateRuntimeRootUnavailableError.js";
import { ProviderStartupDeadline } from "../process/ProviderDeadline.js";
import {
  ProviderProcessSupervisor,
  spawnOwnedProviderProcess,
  type OwnedProviderProcessSpawnOptions,
  type SpawnedOwnedProviderProcess,
} from "../process/ProviderProcess.js";
import {
  WEB_BUNDLE_ANALYSIS_WORKER_LIMITS,
  WEB_BUNDLE_WORKER_MANIFEST,
  webBundleWorkerFileNames,
  webBundleWorkerFrameSchema,
  type WebBundleWorkerFrame,
} from "./WebBundleAnalysisWorkerProtocol.js";

const OPERATION = "analyze_web_bundle";
const PROVIDER = "web-bundle-analysis";
const HEAP_EXHAUSTED = /heap out of memory|heap limit|allocation failed/iu;

/** Replaceable acquisition boundaries for the owned per-script analyzer. */
export interface WebBundleAnalysisWorkerDependencies {
  readonly launcher?: (
    options: OwnedProviderProcessSpawnOptions,
  ) => Promise<SpawnedOwnedProviderProcess>;
  readonly createRuntime?: () => Promise<{
    readonly path: string;
    close(): Promise<void>;
  }>;
  readonly prepareOwnership?: (signal?: AbortSignal) => Promise<void>;
  readonly limits?: {
    readonly heapMb?: number;
    readonly scriptTimeoutMs?: number;
    readonly resultBytes?: number;
  };
}

/** Analyze included scripts in capture order, one outcome per script. */
export type WebBundleScriptAnalyzer = (
  scripts: readonly IncludedScript[],
  options: ExecutionOptions,
) => Promise<Result<WebBundleScriptOutcome[], AnalysisError>>;

/** Owners whose process or private root release failed; retried before reuse. */
const pendingCleanup = new Set<OwnedWebBundleWorker>();

/**
 * Run static analysis in an owned worker with heap and per-script time bounds.
 * A script that exhausts a bound is reported as resource-limited and analysis
 * resumes with the next script in a replacement worker.
 */
export const analyzeWebBundleScripts = async (
  scripts: readonly IncludedScript[],
  options: ExecutionOptions,
  dependencies: WebBundleAnalysisWorkerDependencies = {},
): Promise<Result<WebBundleScriptOutcome[], AnalysisError>> => {
  const signal = options.signal;
  for (const owner of pendingCleanup) {
    const failure = await owner.close(null);
    if (failure !== undefined) return err(failure);
  }
  if (scripts.length === 0) return ok([]);
  try {
    await (dependencies.prepareOwnership ?? prepareProcessOwnershipInspection)(
      signal,
    );
  } catch (cause: unknown) {
    return err(
      signal?.aborted === true
        ? new AnalysisCancelledError(OPERATION, { cause })
        : new ProviderAdapterError(PROVIDER, OPERATION, {
            cause,
            diagnostics: {
              error_message: message(cause),
              phase: "process_ownership_preparation",
            },
          }),
    );
  }
  const worker = new OwnedWebBundleWorker(scripts, signal, dependencies);
  let result: Result<WebBundleScriptOutcome[], AnalysisError>;
  try {
    result = ok(await worker.run());
  } catch (cause: unknown) {
    result = err(worker.failure(cause));
  }
  const cleanup = await worker.close(result.ok ? null : result.error.message);
  if (cleanup !== undefined) return err(cleanup);
  return result.ok && signal?.aborted === true
    ? err(new AnalysisCancelledError(OPERATION, { cause: signal.reason }))
    : result;
};

/** Cleanup failure that retains the worker owner for a later retry. */
export class WebBundleAnalysisCleanupFailure extends ProviderCleanupError {
  constructor(
    readonly cleanupOwner: { close(previousError: string | null): unknown },
    resources: readonly string[],
    diagnostics: Readonly<Record<string, JsonValue>>,
  ) {
    super(PROVIDER, resources, diagnostics, { operation: OPERATION });
  }
}

/** A worker stop that could not be verified; ownership stays with the owner. */
class WorkerReleaseFailure extends Error {}

class OwnedWebBundleWorker {
  readonly #runId = `rea-web-bundle-${randomUUID()}`;
  readonly #limits: {
    readonly [key in keyof typeof WEB_BUNDLE_ANALYSIS_WORKER_LIMITS]: number;
  };
  readonly #memoryLimitBytes: number | null;
  #runtime: { readonly path: string; close(): Promise<void> } | undefined;
  #supervisor: ProviderProcessSupervisor | undefined;
  #frames: WebBundleWorkerFrame[] = [];
  #pending = "";
  #decoder = new StringDecoder("utf8");
  #protocolFailure: string | undefined;
  #processError: string | undefined;
  #deadline: ProviderStartupDeadline | undefined;
  #wake: (() => void) | undefined;
  readonly #onStdout = (chunk: Buffer | string): void => {
    try {
      this.#pending +=
        typeof chunk === "string" ? chunk : this.#decoder.write(chunk);
      let newline: number;
      while ((newline = this.#pending.indexOf("\n")) >= 0) {
        const line = this.#pending.slice(0, newline);
        this.#pending = this.#pending.slice(newline + 1);
        if (
          Buffer.byteLength(line) > this.#limits.frameBytes ||
          this.#frames.length >= 16
        )
          throw new RangeError("Web bundle worker exceeded its frame budget");
        const raw: unknown = JSON.parse(line);
        this.#frames.push(webBundleWorkerFrameSchema.parse(raw));
      }
      if (Buffer.byteLength(this.#pending) > this.#limits.frameBytes)
        throw new RangeError(
          "Web bundle worker frame is unterminated or oversized",
        );
    } catch (cause: unknown) {
      this.#protocolFailure ??= message(cause);
    }
    this.#wake?.();
  };

  constructor(
    readonly scripts: readonly IncludedScript[],
    readonly signal: AbortSignal | undefined,
    readonly dependencies: WebBundleAnalysisWorkerDependencies,
  ) {
    this.#limits = {
      ...WEB_BUNDLE_ANALYSIS_WORKER_LIMITS,
      ...dependencies.limits,
    };
    this.#memoryLimitBytes = javaScriptWorkerMemoryLimitBytes(
      this.#limits.heapMb,
    );
  }

  async run(): Promise<WebBundleScriptOutcome[]> {
    this.#check();
    this.#runtime = await (
      this.dependencies.createRuntime ??
      (() => PrivateRuntimeRoot.create({ prefix: "rea-web-bundle-" }))
    )();
    const scriptBytes: number[] = [];
    for (const [index, script] of this.scripts.entries()) {
      const text = JSON.stringify(script);
      scriptBytes.push(Buffer.byteLength(text));
      await this.#writePrivate(webBundleWorkerFileNames(index).script, text);
    }
    const manifest = JSON.stringify({ script_bytes: scriptBytes });
    await this.#writePrivate(WEB_BUNDLE_WORKER_MANIFEST, manifest);
    const outcomes: WebBundleScriptOutcome[] = [];
    while (outcomes.length < this.scripts.length) {
      this.#check();
      await this.#spawn(Buffer.byteLength(manifest), outcomes.length);
      await this.#collect(outcomes);
    }
    return outcomes;
  }

  async #writePrivate(name: string, text: string): Promise<void> {
    const runtime = this.#runtime;
    if (runtime === undefined) throw new TypeError("Runtime was released");
    this.#check();
    await writeFile(join(runtime.path, name), text, {
      flag: "wx",
      mode: 0o600,
      ...(this.signal === undefined ? {} : { signal: this.signal }),
    });
  }

  /** Consume frames until all scripts finish or this worker stops at a bound. */
  async #collect(outcomes: WebBundleScriptOutcome[]): Promise<void> {
    while (outcomes.length < this.scripts.length) {
      const index = outcomes.length;
      const script = this.scripts[index];
      if (script === undefined) throw new TypeError("Script index is invalid");
      const started = await this.#next(this.#limits.startupTimeoutMs);
      if (started === "timeout")
        throw new AnalysisTimeoutError(
          OPERATION,
          this.#limits.startupTimeoutMs,
        );
      if (started !== "exited" && started.kind !== "start")
        throw new AnalysisOutputError(
          OPERATION,
          "Web bundle worker reported a script before starting it",
        );
      if (started !== "exited" && started.index !== index)
        throw new AnalysisOutputError(
          OPERATION,
          "Web bundle worker started an unexpected script",
        );
      const finished =
        started === "exited"
          ? started
          : await this.#next(this.#limits.scriptTimeoutMs);
      if (finished === "timeout" || finished === "exited") {
        const limited = this.#limitedOutcome(script, finished);
        if (limited === undefined) throw this.#exitFailure(index);
        await this.#release();
        outcomes.push(limited);
        return;
      }
      if (finished.kind === "start" || finished.index !== index)
        throw new AnalysisOutputError(
          OPERATION,
          "Web bundle worker reported an unexpected script",
        );
      outcomes.push(
        finished.kind === "oversized"
          ? {
              status: "resource_limited",
              script_key: script.script_key,
              resource: "capacity",
              reason: `Static analysis facts for this script (${String(finished.bytes)} bytes) exceed the ${String(this.#limits.resultBytes)}-byte per-script result budget; its findings were omitted.`,
            }
          : await this.#readFacts(script, finished),
      );
    }
  }

  /** Classify a stopped script; undefined means an unexplained worker exit. */
  #limitedOutcome(
    script: IncludedScript,
    cause: "timeout" | "exited",
  ): WebBundleScriptOutcome | undefined {
    if (cause === "timeout")
      return {
        status: "resource_limited",
        script_key: script.script_key,
        resource: "cpu",
        reason: `Static analysis of this script did not finish within its ${String(this.#limits.scriptTimeoutMs)} ms budget; its findings were omitted.`,
      };
    const snapshot = this.#supervisor?.snapshot();
    return snapshot !== undefined &&
      (snapshot.memoryLimitReached === true ||
        HEAP_EXHAUSTED.test(snapshot.stderr.text))
      ? {
          status: "resource_limited",
          script_key: script.script_key,
          resource: "memory",
          reason: `Static analysis of this script exhausted the ${String(this.#limits.heapMb)} MiB worker heap; its findings were omitted.`,
        }
      : undefined;
  }

  async #readFacts(
    script: IncludedScript,
    frame: Extract<WebBundleWorkerFrame, { kind: "done" }>,
  ): Promise<WebBundleScriptOutcome> {
    const runtime = this.#runtime;
    if (runtime === undefined) throw new TypeError("Runtime was released");
    if (frame.bytes > this.#limits.resultBytes)
      throw new AnalysisOutputError(
        OPERATION,
        "Web bundle worker result exceeds its declared budget",
      );
    const path = join(
      runtime.path,
      webBundleWorkerFileNames(frame.index).facts,
    );
    const data = await readStableArtifact(
      path,
      this.#limits.resultBytes,
      this.signal,
    );
    await rm(path, { force: true });
    if (
      data.bytes.length !== frame.bytes ||
      createHash("sha256").update(data.bytes).digest("hex") !== frame.sha256
    )
      throw new AnalysisOutputError(
        OPERATION,
        "Web bundle worker result does not match its control frame",
      );
    const value: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(data.bytes),
    );
    const facts = webBundleScriptFactsSchema.parse(value);
    if (facts.script_key !== script.script_key)
      throw new AnalysisOutputError(
        OPERATION,
        "Web bundle worker result names a different script",
      );
    return { status: "analyzed", facts };
  }

  /** Wait for the next frame within one phase deadline, or report exit/timeout. */
  async #next(
    timeoutMs: number,
  ): Promise<WebBundleWorkerFrame | "timeout" | "exited"> {
    this.#deadline?.dispose();
    const deadline = new ProviderStartupDeadline(timeoutMs, this.signal);
    this.#deadline = deadline;
    try {
      for (;;) {
        this.#check();
        const frame = this.#frames.shift();
        if (frame !== undefined) return frame;
        if (deadline.interruption === "timeout") return "timeout";
        const supervisor = this.#supervisor;
        if (supervisor === undefined) return "exited";
        const snapshot = supervisor.snapshot();
        if (snapshot.exitCode !== undefined || snapshot.signal !== undefined) {
          // Exit is not complete output: drain any final frame first.
          if (!(await supervisor.waitForOutputClose(50, deadline.signal)))
            continue;
          if (this.#frames.length !== 0) continue;
          this.#check();
          return "exited";
        }
        await this.#activity(deadline.signal);
      }
    } finally {
      deadline.dispose();
      if (this.#deadline === deadline) this.#deadline = undefined;
    }
  }

  /** Wait for a frame, exit or abort; the interval bounds missed output-close events. */
  #activity(signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const settle = (): void => {
        clearTimeout(timer);
        signal.removeEventListener("abort", settle);
        if (this.#wake === settle) this.#wake = undefined;
        resolve();
      };
      const timer = setTimeout(settle, 50);
      signal.addEventListener("abort", settle, { once: true });
      this.#wake = settle;
    });
  }

  async #spawn(manifestBytes: number, start: number): Promise<void> {
    const runtime = this.#runtime;
    if (runtime === undefined) throw new TypeError("Runtime was released");
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      UV_THREADPOOL_SIZE: "1",
    };
    delete environment.NODE_OPTIONS;
    this.#frames = [];
    this.#pending = "";
    this.#decoder = new StringDecoder("utf8");
    const spawned = await (
      this.dependencies.launcher ?? spawnOwnedProviderProcess
    )({
      command: process.execPath,
      arguments: [
        `--max-old-space-size=${String(this.#limits.heapMb)}`,
        "--max-semi-space-size=8",
        "--v8-pool-size=1",
        "--stack_size=2048",
        fileURLToPath(import.meta.resolve("#web-bundle-analysis-worker")),
        String(manifestBytes),
        String(start),
        String(this.#limits.resultBytes),
      ],
      runId: `${this.#runId}-${String(start)}`,
      cwd: runtime.path,
      hostEnvironment: environment,
      ...(this.#memoryLimitBytes === null
        ? {}
        : { memoryLimitBytes: this.#memoryLimitBytes }),
      ...(this.signal === undefined ? {} : { signal: this.signal }),
    });
    this.#supervisor = new ProviderProcessSupervisor(
      {
        ...spawned,
        ownsProcessLifetime: true,
        cleanup:
          spawned.cleanup ??
          (() => cleanupOwnedProcessGroup(spawned.ownership)),
      },
      {
        captureStdout: false,
        maxDiagnosticBytes: 256 * 1024,
        onDiagnostic: (event) => {
          if (event.type === "error") this.#processError ??= event.message;
          if (event.type === "exit" || event.type === "error") this.#wake?.();
        },
      },
    );
    spawned.process.stdout?.on("data", this.#onStdout);
  }

  /** Stop the current worker; an unverified stop keeps it owned for retry. */
  async #release(): Promise<void> {
    const supervisor = this.#supervisor;
    if (supervisor === undefined) return;
    supervisor.launch.process.stdout?.off("data", this.#onStdout);
    const stopped = await supervisor.stop();
    if (stopped.status === "incomplete")
      throw new WorkerReleaseFailure(stopped.reason);
    this.#supervisor = undefined;
  }

  #exitFailure(index: number): AnalysisError {
    const snapshot = this.#supervisor?.snapshot();
    return new ProviderAdapterError(PROVIDER, OPERATION, {
      diagnostics: {
        script_index: index,
        exit_code: snapshot?.exitCode ?? null,
        signal: snapshot?.signal ?? null,
        stderr: snapshot?.stderr.text ?? "",
      },
    });
  }

  #check(): void {
    if (this.signal?.aborted === true)
      throw new AnalysisCancelledError(OPERATION, {
        cause: this.signal.reason,
      });
    if (this.#protocolFailure !== undefined)
      throw new AnalysisOutputError(OPERATION, this.#protocolFailure);
    if (this.#processError !== undefined)
      throw new ProviderAdapterError(PROVIDER, OPERATION, {
        diagnostics: { error_message: this.#processError },
      });
  }

  failure(cause: unknown): AnalysisError {
    if (this.signal?.aborted === true)
      return new AnalysisCancelledError(OPERATION, {
        cause: this.signal.reason,
      });
    if (cause instanceof AnalysisError) return cause;
    if (cause instanceof PrivateRuntimeRootUnavailableError)
      return new AnalysisCapabilityUnavailableError(
        PROVIDER,
        OPERATION,
        cause.message,
        { cause, retryable: cause.retryable },
      );
    return new ProviderAdapterError(PROVIDER, OPERATION, {
      cause,
      diagnostics: { error_message: message(cause) },
    });
  }

  /** Verify worker stop before releasing the private root; failures stay owned. */
  async close(
    previousError: string | null,
  ): Promise<ProviderCleanupError | undefined> {
    this.#deadline?.dispose();
    const failures: string[] = [];
    try {
      await this.#release();
    } catch (cause: unknown) {
      failures.push(message(cause));
    }
    if (this.#supervisor === undefined && this.#runtime !== undefined) {
      try {
        await this.#runtime.close();
        this.#runtime = undefined;
      } catch (cause: unknown) {
        failures.push(message(cause));
      }
    }
    if (failures.length === 0) {
      pendingCleanup.delete(this);
      return undefined;
    }
    pendingCleanup.add(this);
    return new WebBundleAnalysisCleanupFailure(
      this,
      [
        this.#runId,
        ...(this.#runtime === undefined ? [] : [this.#runtime.path]),
      ],
      {
        cleanup_failures: failures,
        previous_error: previousError,
        worker_pid: this.#supervisor?.launch.process.pid ?? null,
      },
    );
  }
}

const message = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);
