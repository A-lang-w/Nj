import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import {
  ArtifactFileCleanupFailure,
  artifactFileCancellationCause,
  bindArtifactFileCleanup,
} from "../artifacts/ArtifactFileOperation.js";
import { analysisErrorWithCleanupFailure } from "../domain/analysisErrorCleanup.js";
import { ArtifactOperationError } from "../domain/artifactOperationError.js";
import {
  AnalysisAccessDeniedError,
  AnalysisArtifactChangedError,
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisResourceConstraintError,
} from "../domain/analysisErrorCore.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";

/** One portable stable-file parser operation and its caller-visible budgets. */
export interface StableFileOperation {
  readonly operation: "inspect_pe_resources" | "inspect_packer_indicators";
  readonly providerId: string;
  readonly path: string;
  readonly limits: Readonly<Record<string, number>>;
  /** Format noun used in read failures, for example "PE image". */
  readonly subject: string;
  /**
   * Remediation for a deterministic caller-selected budget refusal
   * (file-size or capacity). Such refusals are reported as non-retryable.
   */
  readonly budgetRemediation?: (boundary: "file-size" | "capacity") => string;
}

const stableFileFailurePrimary = (
  cause: unknown,
  target: StableFileOperation,
): AnalysisError => {
  const { operation } = target;
  if (cause instanceof ArtifactReaderFailure && cause.reason === "integrity")
    return new AnalysisArtifactChangedError(
      operation,
      target.path,
      cause.message,
      { cause },
    );
  if (cause instanceof ArtifactReaderFailure && cause.reason === "cancelled")
    return new AnalysisCancelledError(operation, {
      cause: artifactFileCancellationCause(cause),
    });

  if (cause instanceof ArtifactReaderFailure) {
    // An input byte budget is a file-size bound, not a memory constraint, and
    // an entry budget is a capacity bound. Report what was actually exceeded.
    if (cause.reason === "limit") {
      const boundary = cause.boundary;
      return new AnalysisResourceConstraintError(
        operation,
        boundary ?? "memory",
        cause.message,
        target.limits,
        {
          cause,
          // Caller-selected bounds are deterministic for the same input, so
          // waiting for an active analysis cannot help.
          ...(boundary === undefined || boundary === "memory"
            ? {}
            : {
                retryable: false,
                ...(target.budgetRemediation === undefined
                  ? {}
                  : { remediationAction: target.budgetRemediation(boundary) }),
              }),
        },
      );
    }
    if (cause.reason === "path" || cause.reason === "format")
      return new AnalysisInputError(operation, { cause }, [
        {
          path: ["path"],
          reason: "invalid_format",
          message: cause.message,
        },
      ]);
  }

  if (cause instanceof Error && "code" in cause) {
    if (cause.code === "EACCES" || cause.code === "EPERM")
      return new AnalysisAccessDeniedError(operation, target.path, cause.code, {
        cause,
      });
    if (cause.code === "ENOENT" || cause.code === "ENOTDIR")
      return new AnalysisInputError(operation, { cause }, [
        {
          path: ["path"],
          reason: "invalid_value",
          message: `Selected ${target.subject} could not be read (${cause.code}): ${target.path}.`,
        },
      ]);
  }

  return new ArtifactOperationError(
    operation,
    cause instanceof ArtifactReaderFailure ? cause.reason : "io",
    undefined,
    cause instanceof Error
      ? cause.message
      : `${target.subject} inspection failed.`,
    { cause },
  );
};

/** Map stable-read and parser failures to typed errors, retaining cleanup failures. */
export const stableFileFailure = (
  cause: unknown,
  target: StableFileOperation,
  signal: AbortSignal | undefined,
): AnalysisError => {
  const primary =
    cause instanceof ArtifactFileCleanupFailure &&
    cause.fileCleanupFailure.outcome.kind === "failed"
      ? stableFileFailurePrimary(cause.fileCleanupFailure.outcome.cause, target)
      : cause instanceof ArtifactFileCleanupFailure && signal?.aborted
        ? new AnalysisCancelledError(target.operation, {
            cause: signal.reason,
          })
        : stableFileFailurePrimary(cause, target);
  if (!(cause instanceof ArtifactReaderFailure) || cause.cleanup === undefined)
    return primary;
  const cleanup = new ProviderCleanupError(
    target.providerId,
    cause.cleanup.resources,
    { reason: cause.cleanup.reason },
    { operation: target.operation, cause },
  );
  const error = analysisErrorWithCleanupFailure(
    primary,
    cleanup,
    target.operation,
  );
  bindArtifactFileCleanup(cause, error);
  return error;
};
