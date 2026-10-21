import { readFileSync } from "node:fs";
import { Worker } from "node:worker_threads";

import { z } from "zod";

import type { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisOutputError,
  AnalysisResourceConstraintError,
} from "../domain/analysisErrorCore.js";
import { err, ok, type Result } from "../domain/result.js";

const MATCHING_DEADLINE_MS = 5_000;
const WORKER_HEAP_MIB = 128;
/**
 * Node's Worker `resourceLimits.maxOldGenerationSizeMb` request. A positive
 * `--max-old-space-size` on the process that starts REA, including
 * `NODE_OPTIONS`, overrides it. A zero or empty value leaves this request
 * in effect. `NODE_OPTIONS` is applied before `process.execArgv`, and the
 * last absolute flag wins. That environment value is not copied into `execArgv`.
 *
 * `--max-old-space-size-percentage` is applied after both sources and takes
 * precedence over the absolute flag in either order. Node turns it into a MiB
 * from constrained or total memory while parsing options. That base can change
 * before user code reads it, and some Node versions also cap total memory at
 * 4 GiB when pointer compression is on. A later read is not the value Node
 * applied, so a percentage flag leaves the effective heap unestablished
 * instead of the 128 MiB request or an absolute flag.
 *
 * `process.env.NODE_OPTIONS` is not that launch value. A preload can clear or
 * rewrite it after V8 has already applied the original flags, and those flags
 * are not copied into `process.execArgv`. The launch string is the
 * `NODE_OPTIONS` entry in the process initial environment when that block can
 * be read. Otherwise the effective heap stays unestablished.
 *
 * `--max-heap-size` is the total heap, not the old generation. A positive
 * value can be lower than the 128 MiB request and still changes the result
 * when an old-space flag is also present. The old generation stays
 * unestablished while that value is in effect. Zero or empty clears it.
 * Node 24 and later also accept the flag in `NODE_OPTIONS`.
 *
 * `--experimental-config-file` and `--experimental-default-config-file` can
 * set `nodeOptions`, including a heap percentage, from a file. That file is
 * not launch provenance, and it can add heap options when `NODE_OPTIONS` was
 * already set. Either flag leaves the old generation unestablished. Node
 * accepts the config path as `=` or the next argument. Underscore spellings
 * are not these flags.
 */
const OLD_SPACE_FLAG = /^--max[-_]old[-_]space[-_]size(?:=(.*))?$/u;
const OLD_SPACE_PERCENT_FLAG =
  /^--max[-_]old[-_]space[-_]size[-_]percentage(?:=.*)?$/u;
const MAX_HEAP_FLAG = /^--max[-_]heap[-_]size(?:=(.*))?$/u;
/**
 * Node applies `NODE_OPTIONS` from `--env-file` / `--env-file-if-exists` only
 * when the variable was absent. The file is not in `/proc/self/environ`, and a
 * later read is not the startup contents. Underscore spellings are not this flag.
 */
const ENV_FILE_FLAG = /^--env-file(?:-if-exists)?(?:=.*)?$/u;
/** Path form and the boolean default-file flag. The file itself is not read. */
const CONFIG_FILE_FLAG = /^--experimental-(?:default-)?config-file(?:=.*)?$/u;

/** Old-generation heap the regex worker will actually hit. */
export type RegexWorkerHeapLimit =
  | {
      readonly kind: "effective";
      readonly mib: number;
      /** True when a positive `--max-old-space-size` overrides the 128 MiB request. */
      readonly overridden: boolean;
    }
  | { readonly kind: "unknown" };

const requestedHeap = {
  kind: "effective",
  mib: WORKER_HEAP_MIB,
  overridden: false,
} as const satisfies RegexWorkerHeapLimit;

/** Node's `ParseNodeOptionsEnvVar`: quotes group tokens and are not part of them. */
const nodeOptionsArgv = (
  nodeOptions: string,
): readonly string[] | undefined => {
  const argv: string[] = [];
  let inString = false;
  let startNew = true;
  for (let index = 0; index < nodeOptions.length; index += 1) {
    let character = nodeOptions.charAt(index);
    if (character === "\\" && inString) {
      if (index + 1 >= nodeOptions.length) return undefined;
      index += 1;
      character = nodeOptions.charAt(index);
    } else if (character === " " && !inString) {
      startNew = true;
      continue;
    } else if (character === '"') {
      inString = !inString;
      continue;
    }
    if (startNew) {
      argv.push(character);
      startNew = false;
    } else {
      const last = argv.length - 1;
      argv[last] = `${argv[last] ?? ""}${character}`;
    }
  }
  return inString ? undefined : argv;
};

const parsedFlagMiB = (
  token: string,
  flag: RegExp,
): number | "absent" | "unrecognized" => {
  const match = flag.exec(token);
  if (match === null) return "absent";
  const raw = match[1];
  if (raw === undefined) return "unrecognized";
  if (raw === "") return 0;
  if (!/^\+?\d+$/u.test(raw)) return "unrecognized";
  const mib = Number(raw);
  return Number.isSafeInteger(mib) ? mib : "unrecognized";
};

/**
 * Derive the worker old-generation heap from launch flags the caller already
 * recovered. The raw `NODE_OPTIONS` string is not retained. This does not read
 * `process.env`.
 */
export const resolveRegexWorkerHeap = (
  execArgv: readonly string[],
  nodeOptions: string | undefined,
): RegexWorkerHeapLimit => {
  const fromEnvironment =
    nodeOptions === undefined ? [] : nodeOptionsArgv(nodeOptions);
  const tokens = [...(fromEnvironment ?? []), ...execArgv];
  // An absent NODE_OPTIONS lets the env file supply one, including a percentage
  // that beats a later absolute flag. The file's text is not launch provenance.
  // A Node config file can inject nodeOptions even when NODE_OPTIONS was
  // recovered. The file is not read back.
  if (
    tokens.some((token) => CONFIG_FILE_FLAG.test(token)) ||
    (nodeOptions === undefined &&
      tokens.some((token) => ENV_FILE_FLAG.test(token)))
  )
    return { kind: "unknown" };
  let limit: RegexWorkerHeapLimit =
    fromEnvironment === undefined ? { kind: "unknown" } : requestedHeap;
  let percentage = false;
  let maxHeap: "clear" | "positive" | "unrecognized" = "clear";
  for (const token of tokens) {
    if (OLD_SPACE_PERCENT_FLAG.test(token)) {
      percentage = true;
      limit = { kind: "unknown" };
      continue;
    }
    // A percentage flag wins over every absolute flag, including a later one.
    if (percentage) continue;
    const totalHeap = parsedFlagMiB(token, MAX_HEAP_FLAG);
    if (totalHeap === "unrecognized") {
      maxHeap = "unrecognized";
      continue;
    }
    if (totalHeap !== "absent") {
      if (maxHeap !== "unrecognized")
        maxHeap = totalHeap > 0 ? "positive" : "clear";
      continue;
    }
    const parsed = parsedFlagMiB(token, OLD_SPACE_FLAG);
    if (parsed === "absent") continue;
    if (parsed === "unrecognized") {
      limit = { kind: "unknown" };
      continue;
    }
    limit =
      parsed > 0
        ? { kind: "effective", mib: parsed, overridden: true }
        : requestedHeap;
  }
  // A positive total-heap cap is not an old-generation size. Zero clears it
  // and leaves the old-space result. An unparsed value does not.
  return maxHeap === "clear" ? limit : { kind: "unknown" };
};

/** Provenance of the `NODE_OPTIONS` value Node applied before user code ran. */
export type LaunchNodeOptions =
  | { readonly kind: "recovered"; readonly value: string | undefined }
  | { readonly kind: "unrecoverable" };

const nodeOptionsKey = Buffer.from("NODE_OPTIONS=");

/** First `NODE_OPTIONS` entry, matching `getenv`. The surrounding block is not retained. */
const nodeOptionsFromEnviron = (
  raw: Buffer,
): string | undefined | "invalid" => {
  let offset = 0;
  while (offset < raw.length) {
    const end = raw.indexOf(0, offset);
    const entryEnd = end === -1 ? raw.length : end;
    const entry = raw.subarray(offset, entryEnd);
    if (
      entry.length >= nodeOptionsKey.length &&
      entry.subarray(0, nodeOptionsKey.length).equals(nodeOptionsKey)
    ) {
      try {
        return new TextDecoder("utf-8", { fatal: true }).decode(
          entry.subarray(nodeOptionsKey.length),
        );
      } catch {
        return "invalid";
      }
    }
    if (end === -1) break;
    offset = end + 1;
  }
  return undefined;
};

/**
 * Linux keeps the `execve` environment in `/proc/self/environ` after
 * `process.env` is rewritten. Other platforms have no equivalent immutable
 * block, so the launch value stays unrecoverable there.
 */
export const readLaunchNodeOptions = (): LaunchNodeOptions => {
  if (process.platform !== "linux") return { kind: "unrecoverable" };
  let raw: Buffer;
  try {
    raw = readFileSync("/proc/self/environ");
  } catch {
    return { kind: "unrecoverable" };
  }
  const value = nodeOptionsFromEnviron(raw);
  return value === "invalid"
    ? { kind: "unrecoverable" }
    : { kind: "recovered", value };
};

/** Heap for this process. Unrecoverable `NODE_OPTIONS` provenance stays unknown. */
export const resolveLaunchRegexWorkerHeap = (
  execArgv: readonly string[],
  launchNodeOptions: LaunchNodeOptions,
): RegexWorkerHeapLimit =>
  launchNodeOptions.kind === "unrecoverable"
    ? { kind: "unknown" }
    : resolveRegexWorkerHeap(execArgv, launchNodeOptions.value);

const launchRegexWorkerHeap = resolveLaunchRegexWorkerHeap(
  process.execArgv,
  readLaunchNodeOptions(),
);

const heapBound = (heap: RegexWorkerHeapLimit): string => {
  if (heap.kind === "unknown")
    return "The worker requests 128 MiB. The effective old-generation heap was not established from the launch flags. --max-old-space-size, --max-old-space-size-percentage, --max-heap-size, --env-file, --env-file-if-exists, --experimental-config-file, and --experimental-default-config-file can change that request.";
  const override =
    "A positive Node --max-old-space-size, including NODE_OPTIONS, overrides the 128 MiB worker request";
  return heap.overridden
    ? `${override} and sets this process's effective heap to ${String(heap.mib)} MiB.`
    : `${override}. This process has no positive override, so the effective heap is ${String(heap.mib)} MiB.`;
};

/** Capability text for the supervised ECMAScript matching boundary. */
export const regexMatchingLimitation = (heap: RegexWorkerHeapLimit): string => {
  const preface =
    heap.kind === "effective"
      ? `Regex mode uses ECMAScript Unicode semantics in a cancellable worker with a ${String(MATCHING_DEADLINE_MS / 1000)}-second matching deadline and an effective ${String(heap.mib)} MiB old-generation heap.`
      : `Regex mode uses ECMAScript Unicode semantics in a cancellable worker with a ${String(MATCHING_DEADLINE_MS / 1000)}-second matching deadline.`;
  return `${preface} This release has no runtime override for the deadline. ${heapBound(heap)} Matching failure leaves the service available.`;
};

/** Shared capability text for the supervised ECMAScript matching boundary. */
export const REGEX_MATCHING_LIMITATION = regexMatchingLimitation(
  launchRegexWorkerHeap,
);

/** Fixed regex deadline. The worker heap is a separate, launch-flag-sensitive cap. */
export const regexMatchingDeadlineError = (
  operation: string,
): AnalysisResourceConstraintError =>
  new AnalysisResourceConstraintError(
    operation,
    "cpu",
    `Regex matching exceeded its supervised deadline of ${String(MATCHING_DEADLINE_MS)} ms. This release has no runtime override. The service remains available.`,
    { matching_deadline_ms: MATCHING_DEADLINE_MS },
    {
      remediationAction: `The regex matching deadline is ${String(MATCHING_DEADLINE_MS)} ms and this release has no runtime override. Simplify the ECMAScript Unicode regex or use literal mode, then retry in the same session.`,
    },
  );

/** Regex worker heap at the effective old-generation limit, which a launch flag can change. */
export const regexWorkerHeapError = (
  operation: string,
  cause: Error,
  heap: RegexWorkerHeapLimit = launchRegexWorkerHeap,
): AnalysisResourceConstraintError =>
  new AnalysisResourceConstraintError(
    operation,
    "memory",
    heap.kind === "effective"
      ? `Regex worker exhausted its effective ${String(heap.mib)} MiB old-generation heap.`
      : "Regex worker exhausted its old-generation heap. The effective heap was not established.",
    heap.kind === "effective"
      ? {
          worker_heap_mib: heap.mib,
          requested_worker_heap_mib: WORKER_HEAP_MIB,
        }
      : { requested_worker_heap_mib: WORKER_HEAP_MIB },
    {
      cause,
      remediationAction: `${heapBound(heap)} Restart REA after changing --max-old-space-size. A launch --max-old-space-size-percentage takes precedence over that flag in either order. Simplify the pattern or use literal mode.`,
    },
  );
const replySchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("matched"),
    indices: z.array(z.number().int().nonnegative()),
  }),
  z.strictObject({ status: z.literal("invalid_pattern"), reason: z.string() }),
]);

// Code is constant; caller patterns and target strings cross only workerData.
const WORKER_SOURCE = String.raw`
(async () => {
const { parentPort, workerData } = await import("node:worker_threads");
let expression;
try {
  expression = new RegExp(workerData.pattern, workerData.caseSensitive ? "u" : "iu");
} catch (cause) {
  parentPort.postMessage({ status: "invalid_pattern", reason: cause instanceof Error ? cause.message : String(cause) });
}
if (expression !== undefined) {
  const indices = [];
  for (const [index, value] of workerData.values.entries())
    if (expression.test(value)) indices.push(index);
  parentPort.postMessage({ status: "matched", indices });
}
})();
`;

/** Match an inventory off the service thread, and prove worker exit before returning. */
export const matchRegexValues = async (input: {
  readonly operation: string;
  readonly pattern: string;
  readonly caseSensitive: boolean;
  readonly values: readonly string[];
  readonly signal?: AbortSignal | undefined;
  readonly invalidPattern?: (reason: string) => AnalysisError;
}): Promise<Result<readonly number[], AnalysisError>> => {
  if (input.signal?.aborted)
    return err(new AnalysisCancelledError(input.operation));
  let worker: Worker;
  try {
    worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: {
        pattern: input.pattern,
        caseSensitive: input.caseSensitive,
        values: input.values,
      },
      resourceLimits: { maxOldGenerationSizeMb: WORKER_HEAP_MIB },
    });
  } catch (cause: unknown) {
    return err(
      new AnalysisOutputError(input.operation, "Cannot start regex worker", {
        cause,
      }),
    );
  }
  try {
    return await new Promise((resolve) => {
      let settled = false;
      const finish = (result: Result<readonly number[], AnalysisError>) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        input.signal?.removeEventListener("abort", onAbort);
        resolve(result);
      };
      const onAbort = () =>
        finish(err(new AnalysisCancelledError(input.operation)));
      const timer = setTimeout(
        () => finish(err(regexMatchingDeadlineError(input.operation))),
        MATCHING_DEADLINE_MS,
      );
      input.signal?.addEventListener("abort", onAbort, { once: true });
      if (input.signal?.aborted) onAbort();
      worker.once("message", (message: unknown) => {
        const reply = replySchema.safeParse(message);
        if (!reply.success)
          return finish(
            err(
              new AnalysisOutputError(
                input.operation,
                "Regex worker reply is malformed",
              ),
            ),
          );
        if (reply.data.status === "invalid_pattern")
          return finish(
            err(
              input.invalidPattern?.(reply.data.reason) ??
                new AnalysisInputError(input.operation, {
                  userMessage: `Invalid regex pattern: ${reply.data.reason}`,
                }),
            ),
          );
        if (
          reply.data.indices.some(
            (index, position, indices) =>
              index >= input.values.length ||
              (position > 0 && index <= (indices[position - 1] ?? -1)),
          )
        )
          return finish(
            err(
              new AnalysisOutputError(
                input.operation,
                "Regex worker returned invalid inventory indices",
              ),
            ),
          );
        finish(ok(reply.data.indices));
      });
      worker.once("error", (cause: Error & { code?: string }) =>
        finish(
          err(
            cause.code === "ERR_WORKER_OUT_OF_MEMORY"
              ? regexWorkerHeapError(input.operation, cause)
              : new AnalysisOutputError(
                  input.operation,
                  `Regex worker failed: ${cause.message}`,
                  { cause },
                ),
          ),
        ),
      );
      worker.once("exit", (code) =>
        finish(
          err(
            new AnalysisOutputError(
              input.operation,
              `Regex worker exited without a result (${String(code)})`,
            ),
          ),
        ),
      );
    });
  } finally {
    await worker.terminate();
  }
};
