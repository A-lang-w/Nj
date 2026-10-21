import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import { waitForExit } from "../process/processFixture.js";

const START_TIMEOUT_MS = 20_000;
const REQUEST_TIMEOUT_MS = 20_000;
const STOP_TIMEOUT_MS = 1_000;
const STDERR_TAIL_CHARS = 4_000;
const workerPath = fileURLToPath(
  new URL("./compiledCliWorker.mjs", import.meta.url),
);
const readyMessage = z.object({ ready: z.literal(true) }).strict();
const responseMessage = z
  .object({
    id: z.number(),
    exitCode: z.number(),
    stdout: z.string(),
    error: z.string().optional(),
  })
  .strict();

type CliResponse = z.infer<typeof responseMessage>;

interface PendingResponse {
  readonly resolve: (response: CliResponse) => void;
  readonly reject: (cause: unknown) => void;
}

interface SessionState {
  child: ChildProcessWithoutNullStreams | undefined;
  starting: Promise<void> | undefined;
  buffer: string;
  nextId: number;
  readonly pending: Map<number, PendingResponse>;
  queue: Promise<void>;
  stderr: string;
  closed: boolean;
  ready: boolean;
  readonly requestTimeoutMs: number;
  readonly stopTimeoutMs: number;
  readonly spawnWorker: () => ChildProcessWithoutNullStreams;
}

/** One warm compiled CLI process serving production JSON commands. */
export interface CompiledCliSession {
  run(args: readonly string[]): Promise<unknown>;
  close(): Promise<void>;
}

/** Limits and process factory for session tests. Production callers omit them. */
export interface CompiledCliSessionOptions {
  readonly spawnWorker?: () => ChildProcessWithoutNullStreams;
  readonly requestTimeoutMs?: number;
  readonly stopTimeoutMs?: number;
}

/** Start a session that loads the compiled CLI once and reuses that process. */
export const startCompiledCliSession = (
  options: CompiledCliSessionOptions = {},
): CompiledCliSession => {
  const state = createSessionState(options);
  return {
    run: (args) => enqueue(state, () => dispatch(state, args)),
    close: () => closeSession(state),
  };
};

const positiveMilliseconds = (
  value: number | undefined,
  fallback: number,
): number =>
  value !== undefined && Number.isSafeInteger(value) && value > 0
    ? value
    : fallback;

const defaultSpawnWorker = (): ChildProcessWithoutNullStreams =>
  spawn(process.execPath, [workerPath], {
    cwd: process.cwd(),
    env: { ...process.env, REA_LOG_LEVEL: "silent" },
    stdio: ["pipe", "pipe", "pipe"],
  });

const createSessionState = (
  options: CompiledCliSessionOptions,
): SessionState => ({
  child: undefined,
  starting: undefined,
  buffer: "",
  nextId: 1,
  pending: new Map(),
  queue: Promise.resolve(),
  stderr: "",
  closed: false,
  ready: false,
  requestTimeoutMs: positiveMilliseconds(
    options.requestTimeoutMs,
    REQUEST_TIMEOUT_MS,
  ),
  stopTimeoutMs: positiveMilliseconds(options.stopTimeoutMs, STOP_TIMEOUT_MS),
  spawnWorker: options.spawnWorker ?? defaultSpawnWorker,
});

const enqueue = (
  state: SessionState,
  task: () => Promise<unknown>,
): Promise<unknown> => {
  const run = state.queue.then(task);
  state.queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
};

const dispatch = async (
  state: SessionState,
  args: readonly string[],
): Promise<unknown> => {
  await ensureStarted(state);
  const child = state.child;
  if (child === undefined)
    throw new Error("Compiled CLI session is not running");
  const id = state.nextId;
  state.nextId += 1;
  const response = await request(state, child, id, args);
  if (response.exitCode !== 0) throw new Error(failureText(state, response));
  return JSON.parse(response.stdout) as unknown;
};

const request = (
  state: SessionState,
  child: ChildProcessWithoutNullStreams,
  id: number,
  args: readonly string[],
): Promise<CliResponse> =>
  new Promise((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (finish: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      state.pending.delete(id);
      finish();
    };
    timer = setTimeout(() => {
      settle(() => {
        reject(
          new Error(
            `Compiled CLI command did not respond within ${String(state.requestTimeoutMs)} ms`,
          ),
        );
        retireChild(state, child);
      });
    }, state.requestTimeoutMs);
    timer.unref();
    state.pending.set(id, {
      resolve: (response) => {
        settle(() => {
          resolve(response);
        });
      },
      reject: (cause) => {
        settle(() => {
          reject(cause);
        });
      },
    });
    child.stdin.write(`${JSON.stringify({ id, args })}\n`, (cause) => {
      if (cause === undefined || cause === null) return;
      settle(() => {
        reject(cause);
      });
    });
  });

const failureText = (state: SessionState, response: CliResponse): string => {
  const detail = response.error ?? response.stdout.slice(0, 500);
  const stderr = state.stderr.trim();
  return stderr.length === 0
    ? `Compiled CLI command failed with status ${String(response.exitCode)}: ${detail}`
    : `Compiled CLI command failed with status ${String(response.exitCode)}: ${detail}\n${stderr}`;
};

const ensureStarted = (state: SessionState): Promise<void> => {
  if (state.closed) return Promise.reject(sessionClosed());
  if (state.ready && state.child !== undefined) return Promise.resolve();
  state.starting ??= launch(state);
  return state.starting;
};

const launch = (state: SessionState): Promise<void> =>
  new Promise((resolve, reject) => {
    const child = state.spawnWorker();
    state.child = child;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new Error(
          `Compiled CLI session did not start within ${String(START_TIMEOUT_MS)} ms\n${state.stderr}`,
        ),
      );
    }, START_TIMEOUT_MS);
    timer.unref();
    const fail = (cause: unknown): void => {
      clearTimeout(timer);
      reject(cause instanceof Error ? cause : new Error(String(cause)));
    };
    const currentChild = (): boolean => state.child === child;
    child.once("error", fail);
    child.once("exit", (code, signal) => {
      if (!currentChild()) return;
      state.child = undefined;
      state.ready = false;
      state.starting = undefined;
      state.buffer = "";
      const cause = new Error(
        `Compiled CLI session exited (${String(code)}, ${String(signal)})\n${state.stderr}`,
      );
      fail(cause);
      rejectPending(state, cause);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (!currentChild()) return;
      state.stderr = `${state.stderr}${chunk}`.slice(-STDERR_TAIL_CHARS);
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (!currentChild()) return;
      state.buffer += chunk;
      drainLines(state, () => {
        clearTimeout(timer);
        state.ready = true;
        resolve();
      });
    });
  });

const retireChild = (
  state: SessionState,
  child: ChildProcessWithoutNullStreams,
): void => {
  if (state.child === child) {
    state.child = undefined;
    state.ready = false;
    state.starting = undefined;
    state.buffer = "";
  }
  child.kill("SIGKILL");
};

const drainLines = (state: SessionState, onReady: () => void): void => {
  let newline = state.buffer.indexOf("\n");
  while (newline !== -1) {
    const line = state.buffer.slice(0, newline);
    state.buffer = state.buffer.slice(newline + 1);
    if (line.length > 0) acceptLine(state, line, onReady);
    newline = state.buffer.indexOf("\n");
  }
};

const acceptLine = (
  state: SessionState,
  line: string,
  onReady: () => void,
): void => {
  let message: unknown;
  try {
    message = JSON.parse(line) as unknown;
  } catch (cause) {
    rejectPending(
      state,
      cause instanceof Error ? cause : new Error(String(cause)),
    );
    return;
  }
  if (readyMessage.safeParse(message).success) {
    onReady();
    return;
  }
  const parsed = responseMessage.safeParse(message);
  if (!parsed.success) {
    rejectPending(
      state,
      new Error("Compiled CLI session returned an unexpected message"),
    );
    return;
  }
  const pending = state.pending.get(parsed.data.id);
  state.pending.delete(parsed.data.id);
  if (pending === undefined) {
    rejectPending(
      state,
      new Error(
        `Compiled CLI session returned unexpected id ${String(parsed.data.id)}`,
      ),
    );
    return;
  }
  pending.resolve(parsed.data);
};

const rejectPending = (state: SessionState, cause: Error): void => {
  for (const pending of state.pending.values()) pending.reject(cause);
  state.pending.clear();
};

const closeSession = async (state: SessionState): Promise<void> => {
  if (state.closed) return;
  state.closed = true;
  const child = state.child;
  if (child === undefined) return;
  rejectPending(state, sessionClosed());
  child.stdin.end();
  if (await waitForExit(child, state.stopTimeoutMs)) return;
  child.kill("SIGTERM");
  if (!(await waitForExit(child, state.stopTimeoutMs))) {
    child.kill("SIGKILL");
    if (!(await waitForExit(child, state.stopTimeoutMs)))
      throw new Error("Compiled CLI session stayed running after SIGKILL");
  }
  throw new Error("Compiled CLI session did not exit after stdin closed");
};

const sessionClosed = (): Error => new Error("Compiled CLI session is closed");
