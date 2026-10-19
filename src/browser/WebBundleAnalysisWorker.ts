import { createHash, randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { readStableArtifact } from "../artifacts/readStableArtifact.js";
import { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import { bindArtifactFileCleanup } from "../artifacts/ArtifactFileOperation.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import { analysisErrorWithCleanupFailure } from "../domain/analysisErrorCleanup.js";
import {
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
  AnalysisOutputError,
  AnalysisTimeoutError,
} from "../domain/analysisErrorCore.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import type { IncludedScript } from "../domain/webBundleAnalyzerInspection.js";
import {
  webBundleScriptFactsSchema,
  type WebBundleScriptOutcome,
} from "../domain/webBundleScriptAnalysis.js";
import { javaScriptRuntime } from "../domain/runtimeVersion.js";
import { javaScriptWorkerMemoryLimitBytes } from "../process/JavaScriptWorkerMemoryLimit.js";
import { cleanupOwnedProcessGroup } from "../process/ProcessOwnership.js";
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
  webBundleWorkerFileNames,
  webBundleWorkerFrameSchema,
  webBundleWorkerRequestSchema,
  type WebBundleWorkerFrame,
} from "./WebBundleAnalysisWorkerProtocol.js";

const OPERATION = "analyze_web_bundle";
const PROVIDER = "web-bundle-analysis";
const HEAP_EXHAUSTED = /heap out of memory|heap limit|allocation failed/iu;
/** Bun accepts but ignores V8 heap flags; see JavaScriptWorkerMemoryLimit. */
const HEAP_FLAGS_ENFORCED = javaScriptRuntime(process.versions).id === "node";
/** Bounded wait for a worker that finished every script to exit on its own. */
const NATURAL_EXIT_GRACE_MS = 5_000;

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

/** A failed analysis; completed outcomes survive a late cancellation or cleanup failure. */
export interface WebBundleScriptAnalysisFailure {
  readonly error: AnalysisError;
  readonly completed?: readonly WebBundleScriptOutcome[];
}

/** A worker stop that could not be verified; ownership stays with the owner. */
class WorkerReleaseFailure extends Error {}

/** One analysis run, retained by its provider until process and root release succeed. */
export class OwnedWebBundleWorker {
  readonly #runId = `rea-web-bundle-${randomUUID()}`;
  readonly #limits: {
    readonly [key in keyof typeof WEB_BUNDLE_ANALYSIS_WORKER_LIMITS]: number;
  };
  readonly #memoryLimitBytes: number | null;
  readonly #outcomes: WebBundleScriptOutcome[] = [];
  #retirementFailure: ProviderCleanupError | undefined;
  #runtime: { readonly path: string; close(): Promise<void> } | undefined;
  readonly #artifacts = new ArtifactResourceScope();
  #supervisor: ProviderProcessSupervisor | undefined;
  #frames: WebBundleWorkerFrame[] = [];
  #pending = "";
  #decoder = new StringDecoder("utf8");
  #protocolFailure: string | undefined;
  #processError: string | undefined;
  #deadline: ProviderStartupDeadline | undefined;
  #wake: (() => void) | undefined;
  readonly #onStdinError = (cause: Error): void => {
    this.#processError ??= cause.message;
    this.#wake?.();
  };
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
          // One ready frame, or start + terminal for the single admitted script.
          this.#frames.length >= 2
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
    const outcomes = this.#outcomes;
    while (outcomes.length < this.scripts.length) {
      this.#check();
      await this.#spawn(outcomes.length);
      await this.#collect(outcomes);
    }
    // Stopping a worker mid-exit can misread its ownership; let it finish first.
    await this.#supervisor?.waitForExit(NATURAL_EXIT_GRACE_MS);
    return outcomes;
  }

  /** Complete facts remain available if finalization throws after acceptance. */
  get completed(): readonly WebBundleScriptOutcome[] | undefined {
    return this.#outcomes.length === this.scripts.length
      ? this.#outcomes
      : undefined;
  }

  async #writePrivate(
    name: string,
    text: string,
    signal: AbortSignal,
  ): Promise<void> {
    const runtime = this.#runtime;
    if (runtime === undefined) throw new TypeError("Runtime was released");
    this.#check();
    await writeFile(join(runtime.path, name), text, {
      flag: "wx",
      mode: 0o600,
      signal,
    });
  }

  /** Consume frames until all scripts finish or this worker stops at a bound. */
  async #collect(outcomes: WebBundleScriptOutcome[]): Promise<void> {
    while (outcomes.length < this.scripts.length) {
      const index = outcomes.length;
      const script = this.scripts[index];
      if (script === undefined) throw new TypeError("Script index is invalid");
      outcomes.push(
        await this.#withinDeadline(this.#limits.scriptTimeoutMs, (deadline) =>
          this.#analyzeScript(script, index, deadline),
        ),
      );
      await this.#retireScriptFiles(index);
      if (this.#supervisor === undefined) return;
    }
  }

  /** Stage, analyze and accept one script under one deadline. */
  async #analyzeScript(
    script: IncludedScript,
    index: number,
    deadline: ProviderStartupDeadline,
  ): Promise<WebBundleScriptOutcome> {
    let outcome: WebBundleScriptOutcome | "timeout" | "exited";
    try {
      outcome = await this.#requestScript(script, index, deadline);
    } catch (cause: unknown) {
      // A failed file close still owns its descriptor and must prevent reuse.
      if (
        this.signal?.aborted === true ||
        deadline.interruption !== "timeout" ||
        this.#artifacts.hasPending
      )
        throw cause;
      outcome = "timeout";
    }
    this.#check();
    // Decoding/validation may block the event loop past the timer callback.
    if (deadline.interruption === "timeout") outcome = "timeout";
    return typeof outcome === "string"
      ? this.#stopLimitedScript(script, index, outcome)
      : outcome;
  }

  /** Accepted outcomes outlive file retirement; failed files stay owned by the root. */
  async #retireScriptFiles(index: number): Promise<void> {
    const root = this.#runtime;
    if (root === undefined) throw new TypeError("Runtime was released");
    try {
      for (const name of Object.values(webBundleWorkerFileNames(index)))
        await rm(join(root.path, name), { force: true });
    } catch (cause: unknown) {
      this.#retirementFailure = new ProviderCleanupError(
        PROVIDER,
        this.cleanupResources,
        { script_index: index, reason: message(cause) },
        { operation: OPERATION, cause },
      ).bindCleanupResourceOwner(this);
      throw this.#retirementFailure;
    }
  }

  /** Only this script's source is on disk while the worker awaits admission. */
  async #requestScript(
    script: IncludedScript,
    index: number,
    deadline: ProviderStartupDeadline,
  ): Promise<WebBundleScriptOutcome | "timeout" | "exited"> {
    this.#check();
    const text = JSON.stringify(script);
    await this.#writePrivate(
      webBundleWorkerFileNames(index).script,
      text,
      deadline.signal,
    );
    const stdin = this.#supervisor?.launch.process.stdin;
    if (stdin === undefined || stdin === null)
      throw new TypeError("Web bundle worker has no writable request stream");
    const request = webBundleWorkerRequestSchema.parse({
      kind: "analyze",
      index,
      script_bytes: Buffer.byteLength(text),
    });
    await new Promise<void>((resolve, reject) => {
      stdin.write(`${JSON.stringify(request)}\n`, (error) =>
        error === null || error === undefined ? resolve() : reject(error),
      );
    });
    const started = await this.#next(deadline);
    if (started === "timeout") return started;
    // An exit before a script starts is not attributable to that script.
    if (started === "exited") throw this.#exitFailure(index);
    if (started.kind !== "start")
      throw new AnalysisOutputError(
        OPERATION,
        "Web bundle worker reported a script before starting it",
      );
    if (started.index !== index)
      throw new AnalysisOutputError(
        OPERATION,
        "Web bundle worker started an unexpected script",
      );
    const finished = await this.#next(deadline);
    if (finished === "timeout" || finished === "exited") {
      return finished;
    }
    if (
      finished.kind === "ready" ||
      finished.kind === "start" ||
      finished.index !== index
    )
      throw new AnalysisOutputError(
        OPERATION,
        "Web bundle worker reported an unexpected script",
      );
    return finished.kind === "oversized"
      ? {
          status: "resource_limited",
          script_key: script.script_key,
          resource: "capacity",
          reason: `Static analysis facts for this script (${String(finished.bytes)} bytes) exceed the ${String(this.#limits.resultBytes)}-byte per-script result budget; its findings were omitted.`,
        }
      : this.#readFacts(script, finished, deadline.signal);
  }

  async #stopLimitedScript(
    script: IncludedScript,
    index: number,
    cause: "timeout" | "exited",
  ): Promise<WebBundleScriptOutcome> {
    const limited = this.#limitedOutcome(script, cause);
    if (limited === undefined) throw this.#exitFailure(index);
    await this.#release();
    return limited;
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
    if (snapshot === undefined) return undefined;
    const bound =
      snapshot.memoryLimitReached === true && this.#memoryLimitBytes !== null
        ? `${String(this.#memoryLimitBytes)}-byte worker process memory limit`
        : HEAP_FLAGS_ENFORCED && HEAP_EXHAUSTED.test(snapshot.stderr.text)
          ? `${String(this.#limits.heapMb)} MiB worker heap`
          : undefined;
    return bound === undefined
      ? undefined
      : {
          status: "resource_limited",
          script_key: script.script_key,
          resource: "memory",
          reason: `Static analysis of this script exhausted the ${bound}; its findings were omitted.`,
        };
  }

  async #readFacts(
    script: IncludedScript,
    frame: Extract<WebBundleWorkerFrame, { kind: "done" }>,
    signal: AbortSignal,
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
      signal,
      undefined,
      this.#artifacts,
    );
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

  /** Own one deadline for startup or a whole script request, never for a frame. */
  async #withinDeadline<T>(
    timeoutMs: number,
    run: (deadline: ProviderStartupDeadline) => Promise<T>,
  ): Promise<T> {
    const deadline = new ProviderStartupDeadline(timeoutMs, this.signal);
    this.#deadline = deadline;
    try {
      return await run(deadline);
    } finally {
      deadline.dispose();
      if (this.#deadline === deadline) this.#deadline = undefined;
    }
  }

  /** Check the absolute deadline before accepting even an already-queued frame. */
  async #next(
    deadline: ProviderStartupDeadline,
  ): Promise<WebBundleWorkerFrame | "timeout" | "exited"> {
    for (;;) {
      this.#check();
      if (deadline.interruption === "timeout") return "timeout";
      const frame = this.#frames.shift();
      if (frame !== undefined) return frame;
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

  async #spawn(start: number): Promise<void> {
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
        String(this.scripts.length),
        String(start),
        String(this.#limits.resultBytes),
      ],
      runId: `${this.#runId}-${String(start)}`,
      cwd: runtime.path,
      hostEnvironment: environment,
      stdin: "pipe",
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
    spawned.process.stdin?.on("error", this.#onStdinError);
    await this.#withinDeadline(
      this.#limits.startupTimeoutMs,
      async (deadline) => {
        const ready = await this.#next(deadline);
        if (ready === "timeout")
          throw new AnalysisTimeoutError(
            OPERATION,
            this.#limits.startupTimeoutMs,
          );
        if (ready === "exited") throw this.#exitFailure(start);
        if (ready.kind !== "ready")
          throw new AnalysisOutputError(
            OPERATION,
            "Web bundle worker did not complete its startup handshake",
          );
      },
    );
  }

  /** Stop the current worker; an unverified stop keeps it owned for retry. */
  async #release(): Promise<void> {
    const supervisor = this.#supervisor;
    if (supervisor === undefined) return;
    supervisor.launch.process.stdout?.off("data", this.#onStdout);
    const stopped = await supervisor.stop();
    if (stopped.status === "incomplete")
      throw new WorkerReleaseFailure(stopped.reason);
    supervisor.launch.process.stdin?.off("error", this.#onStdinError);
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
    const primary = this.#primaryFailure(cause);
    if (
      cause instanceof ProviderCleanupError &&
      cause === this.#retirementFailure
    )
      return primary === cause
        ? primary
        : analysisErrorWithCleanupFailure(
            primary,
            cause,
            OPERATION,
          ).bindCleanupDependencies([primary, cause]);
    if (
      !(cause instanceof ArtifactReaderFailure) ||
      cause.cleanup === undefined
    )
      return primary;
    const cleanup = new ProviderCleanupError(
      PROVIDER,
      cause.cleanup.resources,
      { reason: cause.cleanup.reason },
      { cause, operation: OPERATION },
    );
    bindArtifactFileCleanup(cause, cleanup);
    return analysisErrorWithCleanupFailure(
      primary,
      cleanup,
      OPERATION,
    ).bindCleanupDependencies([primary, cleanup]);
  }

  #primaryFailure(cause: unknown): AnalysisError {
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
  async close(): Promise<ProviderCleanupError | undefined> {
    this.#deadline?.dispose();
    const failures: unknown[] = [];
    try {
      await this.#release();
    } catch (cause: unknown) {
      failures.push(cause);
    }
    try {
      await this.#artifacts.close();
    } catch (cause: unknown) {
      failures.push(cause);
    }
    if (
      this.#supervisor === undefined &&
      !this.#artifacts.hasPending &&
      this.#runtime !== undefined
    ) {
      try {
        await this.#runtime.close();
        this.#runtime = undefined;
      } catch (cause: unknown) {
        failures.push(cause);
      }
    }
    if (failures.length === 0) {
      this.#retirementFailure?.resolveCleanup();
      return undefined;
    }
    return new ProviderCleanupError(
      PROVIDER,
      this.cleanupResources,
      {
        cleanup_failures: failures.map(message),
        worker_pid: this.#supervisor?.launch.process.pid ?? null,
      },
      {
        operation: OPERATION,
        cause: new AggregateError(
          failures,
          "Web bundle resource cleanup failed",
        ),
      },
    ).bindCleanupResourceOwner(this);
  }

  get cleanupResources(): readonly string[] {
    if (
      this.#supervisor === undefined &&
      this.#runtime === undefined &&
      !this.#artifacts.hasPending
    )
      return [];
    return [
      this.#runId,
      ...(this.#runtime === undefined ? [] : [this.#runtime.path]),
      ...this.#artifacts.cleanupResources,
    ];
  }
}

const message = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);
