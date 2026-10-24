import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";

import type { AnalysisCapturedOutput } from "../domain/analysisErrorBase.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { DecodedNdjsonLineBuffer } from "../process/DecodedNdjsonLineBuffer.js";
import { cleanupOwnedProcessGroup } from "../process/ProcessOwnership.js";
import {
  ProviderProcessSupervisor,
  spawnOwnedProviderProcess,
  type OwnedProviderProcessSpawnOptions,
  type ProviderProcessDiagnostic,
  type ProviderProcessStopResult,
  type SpawnedOwnedProviderProcess,
} from "../process/ProviderProcess.js";
import {
  bridgeFrameSchema,
  type BinaryNinjaBridgeReadyFrame,
} from "./BinaryNinjaHeadlessProtocolValues.js";

/** Injectable acquisition seam; production owns a POSIX group or Windows job. */
export type BinaryNinjaHeadlessLauncher = (
  options: OwnedProviderProcessSpawnOptions,
) => Promise<SpawnedOwnedProviderProcess>;

const DEFAULT_MAX_REPLY_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_DIAGNOSTIC_BYTES = 64 * 1024;

/** The bridge answered one request with a stable failure code. */
export class BinaryNinjaBridgeRequestError extends Error {
  constructor(
    readonly op: string,
    readonly code: string,
    message: string,
    readonly details: Readonly<Record<string, JsonValue>>,
  ) {
    super(message);
    this.name = "BinaryNinjaBridgeRequestError";
  }
}

/** The owned interpreter could not start, exited, or broke the line protocol. */
export class BinaryNinjaBridgeProcessError extends Error {
  constructor(
    readonly stage:
      | "spawn"
      | "startup"
      | "protocol"
      | "exit"
      | "transport"
      | "resource",
    message: string,
    readonly code: string | undefined,
    readonly diagnostics: AnalysisCapturedOutput | undefined,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "BinaryNinjaBridgeProcessError";
  }
}

interface PendingRequest {
  readonly op: string;
  resolve(value: JsonValue): void;
  reject(cause: unknown): void;
}

export interface BinaryNinjaHeadlessBridgeProcessOptions {
  readonly command: string;
  readonly arguments: readonly string[];
  /** Bridge-specific variables layered over the snapshot host environment. */
  readonly env: Readonly<NodeJS.ProcessEnv>;
  readonly hostEnvironment: Readonly<NodeJS.ProcessEnv>;
  readonly platform?: NodeJS.Platform | undefined;
  readonly runId?: string | undefined;
  readonly maxReplyBytes?: number | undefined;
  readonly maxDiagnosticBytes?: number | undefined;
  readonly launcher?: BinaryNinjaHeadlessLauncher | undefined;
  readonly onDiagnostic?:
    | ((event: ProviderProcessDiagnostic) => void)
    | undefined;
}

/**
 * One owned headless interpreter speaking newline-delimited JSON on stdio.
 *
 * Requests are serial; the bridge serves one BinaryView on one thread. Any
 * protocol fault or process exit fails every pending request and poisons the
 * instance, so the session starts a fresh interpreter afterwards.
 */
export class BinaryNinjaHeadlessBridgeProcess {
  readonly runId: string;
  readonly #options: BinaryNinjaHeadlessBridgeProcessOptions;
  readonly #lines = new DecodedNdjsonLineBuffer();
  readonly #decoder = new StringDecoder("utf8");
  readonly #pending = new Map<number, PendingRequest>();
  #nextId = 1;
  #partialBytes = 0;
  #spawned: SpawnedOwnedProviderProcess | undefined;
  #supervisor: ProviderProcessSupervisor | undefined;
  #ready: BinaryNinjaBridgeReadyFrame | undefined;
  #readyWaiter:
    | {
        resolve(frame: BinaryNinjaBridgeReadyFrame): void;
        reject(cause: unknown): void;
      }
    | undefined;
  #failure: BinaryNinjaBridgeProcessError | undefined;
  #stopping: Promise<ProviderProcessStopResult> | undefined;

  constructor(options: BinaryNinjaHeadlessBridgeProcessOptions) {
    this.#options = options;
    this.runId = options.runId ?? randomUUID();
  }

  /** Startup facts once the bridge imported the Binary Ninja API. */
  get ready(): BinaryNinjaBridgeReadyFrame | undefined {
    return this.#ready;
  }

  /** Whether the interpreter can no longer serve requests. */
  get failed(): boolean {
    return this.#failure !== undefined || this.#stopping !== undefined;
  }

  /** Spawn the interpreter and wait for its ready frame under the caller's signal. */
  async start(signal?: AbortSignal): Promise<BinaryNinjaBridgeReadyFrame> {
    if (this.#spawned !== undefined)
      throw new Error("Binary Ninja bridge cannot be started twice");
    signal?.throwIfAborted();
    let spawned: SpawnedOwnedProviderProcess;
    try {
      spawned = await (this.#options.launcher ?? spawnOwnedProviderProcess)({
        command: this.#options.command,
        arguments: [...this.#options.arguments],
        runId: this.runId,
        env: { ...this.#options.env },
        hostEnvironment: this.#options.hostEnvironment,
        stdin: "pipe",
        ...(this.#options.platform === undefined
          ? {}
          : { platform: this.#options.platform }),
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (cause: unknown) {
      if (signal?.aborted === true) throw signal.reason;
      throw new BinaryNinjaBridgeProcessError(
        "spawn",
        `Binary Ninja bridge interpreter could not be started: ${cause instanceof Error ? cause.message : String(cause)}`,
        undefined,
        undefined,
        { cause },
      );
    }
    this.#spawned = spawned;
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
        maxDiagnosticBytes:
          this.#options.maxDiagnosticBytes ?? DEFAULT_MAX_DIAGNOSTIC_BYTES,
        ...(this.#options.onDiagnostic === undefined
          ? {}
          : { onDiagnostic: this.#options.onDiagnostic }),
      },
    );
    if (!this.#attach(spawned)) {
      await this.stop();
      throw new BinaryNinjaBridgeProcessError(
        "spawn",
        "Binary Ninja bridge launcher supplied no protocol stdin/stdout",
        undefined,
        this.diagnostics(),
      );
    }
    return new Promise<BinaryNinjaBridgeReadyFrame>((resolve, reject) => {
      if (this.#failure !== undefined) {
        reject(this.#failure);
        return;
      }
      const onAbort = (): void => {
        this.#readyWaiter = undefined;
        void this.stop();
        reject(signal?.reason);
      };
      this.#readyWaiter = {
        resolve: (frame) => {
          signal?.removeEventListener("abort", onAbort);
          resolve(frame);
        },
        reject: (cause) => {
          signal?.removeEventListener("abort", onAbort);
          reject(cause);
        },
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  /** Wire protocol streams and exit observation; false when the launcher gave no pipes. */
  #attach(spawned: SpawnedOwnedProviderProcess): boolean {
    const { process } = spawned;
    if (
      process.stdin === undefined ||
      process.stdin === null ||
      process.stdout === null
    )
      return false;
    process.stdout.on("data", this.#onStdout);
    process.stdout.on("error", this.#onStreamError);
    process.stdin.on("error", this.#onStreamError);
    process.on("error", this.#onStreamError);
    process.once("exit", this.#onExit);
    const exit = this.#supervisor?.observedExit();
    if (exit !== undefined) this.#onExit(exit.code, exit.signal);
    return true;
  }

  /** Send one request; cancellation stops the interpreter rather than waiting. */
  request(
    op: string,
    params: Readonly<Record<string, JsonValue>>,
    signal?: AbortSignal,
  ): Promise<JsonValue> {
    if (this.#failure !== undefined) return Promise.reject(this.#failure);
    if (this.#stopping !== undefined)
      return Promise.reject(
        new BinaryNinjaBridgeProcessError(
          "exit",
          "Binary Ninja bridge is stopping",
          undefined,
          this.diagnostics(),
        ),
      );
    const input = this.#spawned?.process.stdin;
    if (this.#ready === undefined || input === undefined || input === null)
      return Promise.reject(
        new BinaryNinjaBridgeProcessError(
          "transport",
          "Binary Ninja bridge has not completed startup",
          undefined,
          this.diagnostics(),
        ),
      );
    if (signal?.aborted === true) return Promise.reject(signal.reason);
    const id = this.#nextId++;
    return new Promise<JsonValue>((resolve, reject) => {
      const onAbort = (): void => {
        this.#pending.delete(id);
        void this.stop();
        reject(signal?.reason);
      };
      this.#pending.set(id, {
        op,
        resolve: (value) => {
          signal?.removeEventListener("abort", onAbort);
          resolve(value);
        },
        reject: (cause) => {
          signal?.removeEventListener("abort", onAbort);
          reject(cause);
        },
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      input.write(`${JSON.stringify({ id, op, params })}\n`, (cause) => {
        if (cause === null || cause === undefined) return;
        this.#fail(
          new BinaryNinjaBridgeProcessError(
            "transport",
            `Binary Ninja bridge stdin write failed: ${cause.message}`,
            undefined,
            this.diagnostics(),
            { cause },
          ),
        );
      });
    });
  }

  /** Stop the owned interpreter and reject anything still waiting on it. */
  stop(): Promise<ProviderProcessStopResult> {
    this.#stopping ??= (async () => {
      const spawned = this.#spawned;
      const supervisor = this.#supervisor;
      if (spawned === undefined || supervisor === undefined)
        return { status: "not-owned" as const };
      const input = spawned.process.stdin;
      try {
        input?.end();
      } catch {
        // The pipe may already be closed by the exited interpreter.
      }
      const stopped = await supervisor.stop();
      input?.destroy();
      spawned.process.stdout?.off("data", this.#onStdout);
      this.#rejectAll(
        this.#failure ??
          new BinaryNinjaBridgeProcessError(
            "exit",
            "Binary Ninja bridge was stopped",
            undefined,
            this.diagnostics(),
          ),
      );
      return stopped;
    })();
    return this.#stopping;
  }

  /** Captured interpreter stderr without the inherited environment. */
  diagnostics(): AnalysisCapturedOutput | undefined {
    const supervisor = this.#supervisor;
    if (supervisor === undefined) return undefined;
    const snapshot = supervisor.snapshot();
    return {
      stdout: "",
      stderr: snapshot.stderr.text,
      stderr_bytes: snapshot.stderr.observedBytes,
      truncated:
        snapshot.diagnosticTruncated === true ||
        !supervisor.observedOutputClose(),
      ...(snapshot.exitCode === undefined
        ? {}
        : { exit_code: snapshot.exitCode }),
      ...(snapshot.signal === undefined ? {} : { signal: snapshot.signal }),
    };
  }

  readonly #onStdout = (chunk: Buffer | string): void => {
    if (this.#failure !== undefined) return;
    const text = typeof chunk === "string" ? chunk : this.#decoder.write(chunk);
    const maxReplyBytes =
      this.#options.maxReplyBytes ?? DEFAULT_MAX_REPLY_BYTES;
    const lastNewline = text.lastIndexOf("\n");
    this.#partialBytes =
      lastNewline === -1
        ? this.#partialBytes + Buffer.byteLength(text)
        : Buffer.byteLength(text.slice(lastNewline + 1));
    try {
      for (const line of this.#lines.push(text)) {
        if (Buffer.byteLength(line) > maxReplyBytes)
          throw new BinaryNinjaBridgeProcessError(
            "resource",
            `Binary Ninja bridge reply exceeds ${String(maxReplyBytes)} bytes; no complete result is available`,
            undefined,
            this.diagnostics(),
          );
        this.#route(line);
      }
      if (this.#partialBytes > maxReplyBytes)
        throw new BinaryNinjaBridgeProcessError(
          "resource",
          `Binary Ninja bridge reply exceeds ${String(maxReplyBytes)} bytes; no complete result is available`,
          undefined,
          this.diagnostics(),
        );
    } catch (cause: unknown) {
      this.#fail(
        cause instanceof BinaryNinjaBridgeProcessError
          ? cause
          : new BinaryNinjaBridgeProcessError(
              "protocol",
              `Binary Ninja bridge wrote an invalid protocol line: ${cause instanceof Error ? cause.message : String(cause)}`,
              undefined,
              this.diagnostics(),
              { cause },
            ),
      );
    }
  };

  #route(line: string): void {
    const frame = bridgeFrameSchema.parse(JSON.parse(line));
    if ("event" in frame) {
      if (frame.event === "fatal")
        throw new BinaryNinjaBridgeProcessError(
          "startup",
          frame.message,
          frame.code,
          this.diagnostics(),
        );
      if (this.#ready !== undefined) throw new Error("duplicate ready frame");
      this.#ready = frame;
      const waiter = this.#readyWaiter;
      this.#readyWaiter = undefined;
      waiter?.resolve(frame);
      return;
    }
    const pending = frame.id === null ? undefined : this.#pending.get(frame.id);
    if (pending === undefined)
      throw new Error(
        `reply for unknown request ${frame.id === null ? "null" : String(frame.id)}`,
      );
    this.#pending.delete(frame.id as number);
    if (frame.ok) pending.resolve(frame.result);
    else
      pending.reject(
        new BinaryNinjaBridgeRequestError(
          pending.op,
          frame.error.code,
          frame.error.message,
          frame.error.details ?? {},
        ),
      );
  }

  readonly #onStreamError = (cause: Error): void => {
    this.#fail(
      new BinaryNinjaBridgeProcessError(
        "transport",
        `Binary Ninja bridge stream failed: ${cause.message}`,
        undefined,
        this.diagnostics(),
        { cause },
      ),
    );
  };

  readonly #onExit = (
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void => {
    const exit = `code ${code === null ? "null" : String(code)}, signal ${signal ?? "null"}`;
    // An exit nobody waits on, such as after close, only retires this instance.
    if (this.#pending.size === 0 && this.#readyWaiter === undefined) {
      this.#failure ??= new BinaryNinjaBridgeProcessError(
        "exit",
        `Binary Ninja bridge exited (${exit})`,
        undefined,
        this.diagnostics(),
      );
      return;
    }
    this.#fail(
      new BinaryNinjaBridgeProcessError(
        "exit",
        `Binary Ninja bridge exited before answering (${exit})`,
        undefined,
        this.diagnostics(),
      ),
    );
  };

  #fail(failure: BinaryNinjaBridgeProcessError): void {
    this.#failure ??= failure;
    this.#rejectAll(this.#failure);
    void this.stop();
  }

  #rejectAll(failure: BinaryNinjaBridgeProcessError): void {
    const waiter = this.#readyWaiter;
    this.#readyWaiter = undefined;
    waiter?.reject(failure);
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    for (const request of pending) request.reject(failure);
  }
}
