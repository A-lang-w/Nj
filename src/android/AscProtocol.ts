import { createHash } from "node:crypto";

import { z } from "zod";

import {
  createAnalysisExecution,
  type AnalysisExecution,
} from "../application/AnalysisProvider.js";
import {
  AnalysisError,
  type AnalysisCapturedOutput,
} from "../domain/analysisErrorBase.js";
import {
  AnalysisCapabilityUnavailableError,
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisOutputError,
  AnalysisResourceConstraintError,
  AnalysisTimeoutError,
} from "../domain/analysisErrorCore.js";
import {
  androidResultSchemas,
  type AndroidRequest,
} from "../domain/android/androidAnalysis.js";
import type { BinaryTarget } from "../domain/binaryTargetTypes.js";
import { createEvidence } from "../domain/evidence.js";
import {
  jsonObjectSchema,
  jsonValueSchema,
  type JsonValue,
} from "../domain/jsonValue.js";
import type { ProviderProcessSnapshot } from "../process/ProviderProcess.js";
import { OwnedCommandFailure } from "../process/OwnedCommand.js";
import { regularFileCancellation } from "../filesystem/OwnedRegularFile.js";
import { stableFileHashCause } from "../filesystem/StableFileHash.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";

export const ASC_PROVIDER_IDENTITY = {
  id: "asc",
  name: "DroidASC",
  version: null,
} as const;
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const count = z.number().int().nonnegative().safe();
const providerSchema = z.object({
  name: z.literal("droidasc"),
  version: z.null(),
  python_executable: z.string().min(1),
  fingerprint_scope: z.string().min(1),
  modules: z
    .array(
      z.object({
        name: z.string().min(1),
        path: z.string().min(1).nullable(),
        sha256: digest.nullable(),
      }),
    )
    .min(1),
});
const failureSchema = z.object({
  kind: z.string().min(1),
  message: z.string(),
});
const probeSchema = z.object({
  complete: z.boolean(),
  provider: providerSchema.nullable(),
  error: failureSchema.nullable(),
});
const classSchema = probeSchema.extend({
  input: z.object({ path: z.string().min(1), sha256: digest.nullable() }),
  operation: z.literal("classes"),
  query: z.string(),
  total_classes: count,
  coverage: z.object({
    root_dex_entries: count,
    examined_entries: z.array(z.string().min(1)),
    excluded_entries: count,
    scope: z.string().min(1),
  }),
  dexes: z.array(
    z.object({
      entry: z.string().min(1),
      logical_name: z.string().min(1),
      entry_sha256: digest,
      sha256: digest,
    }),
  ),
  classes: z.array(
    z.object({
      dex: count,
      descriptor: z.string().min(1),
      name: z.string().min(1),
    }),
  ),
  occurrences: z.array(z.unknown()).length(0),
});
const LIMITATIONS = [
  "Static DroidASC DEX definitions, including inner classes, use raw canonical names with $ preserved. This inventory is not JADX's top-level decompiler aliases; the APK is never executed.",
  "Coverage is limited to root ZIP DEX entries; embedded DEX, split APK merging, resources, signatures and runtime behavior are not established.",
  "The engine fingerprint covers reported loaded ASC/mutf8 module files and explicit missing-file markers, not executed-byte identity, the full dependency tree or publisher authenticity. Installed-distribution metadata is not treated as source revision or version.",
  "Input, advertised expanded DEX and JSON output budgets do not enforce a process RSS limit. Shared target admission and streaming hashes have separate costs; no OS sandbox or memory cap is claimed.",
] as const;

/** Preserve physical output with an explicit complete/incomplete capture state. */
export const capturedAscOutput = (
  snapshot: ProviderProcessSnapshot,
): AnalysisCapturedOutput => ({
  stdout: snapshot.stdout.text,
  stderr: snapshot.stderr.text,
  truncated:
    snapshot.diagnosticTruncated === true || snapshot.outputIncomplete === true,
  stdout_bytes: snapshot.stdout.observedBytes,
  stderr_bytes: snapshot.stderr.observedBytes,
  exit_code: snapshot.exitCode ?? null,
  signal: snapshot.signal ?? null,
});

/** Decode a complete byte-counted worker response once, preserving bad output. */
export const parseAscOutput = (
  snapshot: ProviderProcessSnapshot,
  operation: string,
): JsonValue => {
  try {
    if (
      snapshot.stdout.invalidUtf8 === true ||
      snapshot.stderr.invalidUtf8 === true
    )
      throw new Error("Worker output is not valid UTF-8");
    return jsonValueSchema.parse(JSON.parse(snapshot.stdout.text));
  } catch (cause: unknown) {
    throw new AnalysisOutputError(
      operation,
      "ASC worker returned malformed JSON or UTF-8.",
      { cause, capturedOutput: capturedAscOutput(snapshot) },
    );
  }
};

/** Interpret named worker failures, never arbitrary stderr or distribution version text. */
export const parseAscProbe = (
  raw: JsonValue,
  snapshot: ProviderProcessSnapshot,
  operation: string,
): z.infer<typeof providerSchema> => {
  const probe = probeSchema.parse(raw);
  if (!probe.complete || probe.error !== null || snapshot.exitCode !== 0) {
    const options = { capturedOutput: capturedAscOutput(snapshot) };
    const message =
      probe.error?.message ??
      "ASC did not return a complete successful observation.";
    if (probe.error?.kind === "provider_unavailable")
      throw new AnalysisCapabilityUnavailableError("asc", operation, message, {
        ...options,
        remediationAction:
          "Supply a compatible reviewed DroidASC installation or PYTHONPATH to the explicit REA_ASC_PYTHON interpreter; REA installs nothing.",
      });
    if (probe.error?.kind === "unsupported")
      throw new AnalysisCapabilityUnavailableError("asc", operation, message, {
        ...options,
        remediationAction:
          "Select a supported standalone APK/DEX format or use the existing JADX workflow explicitly.",
      });
    if (probe.error?.kind === "capacity")
      throw new AnalysisResourceConstraintError(
        operation,
        "capacity",
        message,
        null,
        { ...options, retryable: false },
      );
    if (probe.error?.kind === "identity" || probe.error?.kind === "input")
      throw new AnalysisInputError(operation, options, [
        { path: ["path"], reason: "invalid_value", message },
      ]);
    throw new AnalysisOutputError(operation, message, options);
  }
  if (probe.provider === null)
    throw new AnalysisOutputError(
      operation,
      "ASC omitted its producing module identity.",
    );
  const modules = probe.provider.modules;
  if (
    new Set(modules.map(({ name }) => name)).size !== modules.length ||
    modules.some(({ path, sha256 }) => (path === null) !== (sha256 === null))
  )
    throw new AnalysisOutputError(
      operation,
      "ASC reported duplicate or inconsistent module fingerprint identities.",
    );
  return probe.provider;
};

/** One adapter owner validates all DEX inventory and source-attribution facts. */
export const normalizeAscClassSearch = (
  raw: JsonValue,
  snapshot: ProviderProcessSnapshot,
  target: BinaryTarget,
  request: Extract<AndroidRequest, { operation: "search_android_classes" }>,
): AnalysisExecution => {
  const provider = parseAscProbe(raw, snapshot, request.operation);
  const report = classSchema.parse(raw);
  if (
    report.input.path !== target.path ||
    report.input.sha256 !== target.sha256 ||
    report.query !== request.input.query
  )
    throw new AnalysisOutputError(
      request.operation,
      "ASC returned a different target or query.",
    );
  const examined = new Set(report.coverage.examined_entries);
  const dexEntries = new Set(report.dexes.map(({ entry }) => entry));
  if (
    report.coverage.root_dex_entries === 0 ||
    examined.size !== report.coverage.root_dex_entries ||
    examined.size !== report.coverage.examined_entries.length ||
    report.dexes.length === 0 ||
    dexEntries.size !== examined.size ||
    [...dexEntries].some((entry) => !examined.has(entry)) ||
    report.classes.length > report.total_classes ||
    (request.input.query === "" &&
      report.classes.length !== report.total_classes) ||
    report.classes.some(
      (cls) =>
        report.dexes[cls.dex] === undefined ||
        !cls.name.includes(request.input.query),
    )
  )
    throw new AnalysisOutputError(
      request.operation,
      "ASC class definitions or examined DEX coverage are incomplete or inconsistent.",
    );
  const modules = [...provider.modules]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map(({ name, sha256 }) => ({ name, sha256 }));
  const occurrences = new Map<string, number>();
  for (const cls of report.classes)
    occurrences.set(cls.name, (occurrences.get(cls.name) ?? 0) + 1);
  const result = androidResultSchemas.search_android_classes.parse({
    engine: {
      name: "DroidASC",
      version: null,
      artifact_sha256: createHash("sha256")
        .update(JSON.stringify(modules))
        .digest("hex"),
      source_revision: null,
      worker_count: 1,
      heap_limit_mib: null,
    },
    inventory_kind: "dex_definitions",
    query: request.input.query,
    total_classes: report.total_classes,
    matches: report.classes.map((cls) => cls.name),
    duplicate_names: [...occurrences]
      .filter(([, count]) => count > 1)
      .map(([name, count]) => ({ name, occurrences: count })),
    coverage: "complete",
  });
  return createAnalysisExecution(result, ASC_PROVIDER_IDENTITY, {
    subject: target,
    rawResult: raw,
    limitations: [
      ...LIMITATIONS,
      report.coverage.scope,
      provider.fingerprint_scope,
    ],
    locations: report.dexes.map(({ entry }) => ({
      kind: "artifact-path" as const,
      path: entry,
    })),
  });
};

/** Raw replies survive invalid output, late cancellation and failed owned cleanup. */
export const ascPartialObservation = (
  target: BinaryTarget,
  request: AndroidRequest,
  raw: JsonValue,
  completed?: AnalysisExecution,
) =>
  createEvidence(target, ASC_PROVIDER_IDENTITY, {
    operation: request.operation,
    parameters: jsonObjectSchema.parse(request.input),
    result: completed?.result ?? { status: "partial", complete: false },
    rawResult: completed?.rawResult ?? raw,
    confidence: "observed",
    limitations: completed?.limitations ?? [
      "Producer output is incomplete, invalid or not bound to the selected input; it is not a successful class search.",
    ],
    locations: completed?.locations ?? [],
  });

/** Execution controls are observed by their owners, not inferred from diagnostic text. */
export interface AscFailureContext {
  readonly operation: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly signal: AbortSignal;
  readonly interruption: "cancelled" | "timeout" | undefined;
}

export const ascInterruptionFailure = (
  reason: unknown,
  context: AscFailureContext,
): AnalysisError =>
  context.interruption === "timeout" && reason === context.signal.reason
    ? new AnalysisTimeoutError(context.operation, context.timeoutMs, {
        cause: reason,
      })
    : new AnalysisCancelledError(context.operation, { cause: reason });

/** Translate physical command/read facts without replacing earlier protocol failures. */
export const ascExecutionFailure = (
  cause: unknown,
  context: AscFailureContext,
): AnalysisError => {
  const { operation } = context;
  const cancelled =
    cause instanceof OwnedCommandFailure
      ? cause.cancellation
      : regularFileCancellation(cause);
  if (cancelled !== undefined) {
    const failure = ascInterruptionFailure(cancelled.reason, context);
    if (cause instanceof OwnedCommandFailure && cause.snapshot !== null)
      return failure instanceof AnalysisTimeoutError
        ? new AnalysisTimeoutError(operation, context.timeoutMs, {
            cause: cancelled.reason,
            capturedOutput: capturedAscOutput(cause.snapshot),
          })
        : new AnalysisCancelledError(operation, {
            cause: cancelled.reason,
            capturedOutput: capturedAscOutput(cause.snapshot),
          });
    return failure;
  }
  if (cause instanceof AnalysisError) {
    if (
      cause instanceof AnalysisCancelledError &&
      context.interruption === "timeout" &&
      cause.cause === context.signal.reason
    )
      return new AnalysisTimeoutError(operation, context.timeoutMs, {
        cause: cause.cause,
        partialObservation: cause.partialObservation,
      });
    return cause;
  }
  if (cause instanceof OwnedCommandFailure) {
    const options = {
      cause,
      ...(cause.snapshot === null
        ? {}
        : { capturedOutput: capturedAscOutput(cause.snapshot) }),
    };
    if (cause.reason === "timeout")
      return new AnalysisTimeoutError(operation, context.timeoutMs, options);
    if (cause.reason === "output-limit")
      return new AnalysisResourceConstraintError(
        operation,
        "memory",
        "ASC combined output exceeded REA_ASC_MAX_OUTPUT_BYTES; complete results were not retained.",
        { max_output_bytes: context.maxOutputBytes },
        options,
      );
    return new ProviderAdapterError("asc", operation, options);
  }
  if (cause instanceof z.ZodError || cause instanceof SyntaxError)
    return new AnalysisOutputError(
      operation,
      "ASC returned malformed JSON or violated the worker protocol.",
      { cause },
    );
  return new ProviderAdapterError("asc", operation, {
    cause: stableFileHashCause(cause),
  });
};
