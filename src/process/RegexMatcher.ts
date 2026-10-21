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
 */
const OLD_SPACE_FLAG = /^--max[-_]old[-_]space[-_]size(?:=(.*))?$/u;
const OLD_SPACE_PERCENT_FLAG =
  /^--max[-_]old[-_]space[-_]size[-_]percentage(?:=.*)?$/u;

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

const parsedOldSpaceMiB = (
  token: string,
): number | "absent" | "unrecognized" => {
  const match = OLD_SPACE_FLAG.exec(token);
  if (match === null) return "absent";
  const raw = match[1];
  if (raw === undefined) return "unrecognized";
  if (raw === "") return 0;
  if (!/^\+?\d+$/u.test(raw)) return "unrecognized";
  const mib = Number(raw);
  return Number.isSafeInteger(mib) ? mib : "unrecognized";
};

/**
 * Derive the worker old-generation heap from the launch flags Node already
 * applied. The raw `NODE_OPTIONS` string is not retained.
 */
export const resolveRegexWorkerHeap = (
  execArgv: readonly string[],
  nodeOptions: string | undefined,
): RegexWorkerHeapLimit => {
  const fromEnvironment =
    nodeOptions === undefined ? [] : nodeOptionsArgv(nodeOptions);
  let limit: RegexWorkerHeapLimit =
    fromEnvironment === undefined ? { kind: "unknown" } : requestedHeap;
  let percentage = false;
  for (const token of [...(fromEnvironment ?? []), ...execArgv]) {
    if (OLD_SPACE_PERCENT_FLAG.test(token)) {
      percentage = true;
      limit = { kind: "unknown" };
      continue;
    }
    // A percentage flag wins over every absolute flag, including a later one.
    if (percentage) continue;
    const parsed = parsedOldSpaceMiB(token);
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
  return limit;
};

/** Launch flags are fixed for this process; a later `NODE_OPTIONS` edit does not change them. */
const launchRegexWorkerHeap = resolveRegexWorkerHeap(
  process.execArgv,
  process.env.NODE_OPTIONS,
);

const heapBound = (heap: RegexWorkerHeapLimit): string => {
  if (heap.kind === "unknown")
    return "The worker requests 128 MiB. A launch --max-old-space-size or --max-old-space-size-percentage is set and the effective old-generation heap was not established.";
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
