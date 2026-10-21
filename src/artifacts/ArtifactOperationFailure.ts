import { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  AnalysisInputError,
  AnalysisCancelledError,
  AnalysisUnsupportedTargetError,
} from "../domain/analysisErrorCore.js";
import { analysisErrorWithCleanupFailure } from "../domain/analysisErrorCleanup.js";
import { ArtifactOperationError } from "../domain/artifactOperationError.js";
import { ArtifactReaderFailure } from "./ArtifactReader.js";
import { SafeOutputSourceFailure } from "./SafeOutputSourceFailure.js";
import { AnalysisCleanupLeaseGroup } from "./AnalysisCleanupLease.js";
import {
  ArtifactFileCleanupFailure,
  artifactFileCancellationCause,
  bindArtifactFileCleanup,
} from "./ArtifactFileOperation.js";

/** Translate one artifact boundary failure while retaining cleanup evidence. */
export const translateArtifactFailure = (
  operation: ArtifactOperationError["operation"],
  cause: unknown,
): AnalysisError => {
  if (cause instanceof SafeOutputSourceFailure) {
    // Keep semantic classification with the primary, and cleanup with each
    // producing owner. Normalized wrapper metadata is only a snapshot.
    const primary = translateOwnedArtifactFailure(operation, cause.cause);
    const secondary = cause.sourceFailures.map((failure) =>
      translateOwnedArtifactFailure(operation, failure),
    );
    const pending = secondary.filter((failure) => failure.cleanupIncomplete);
    let error = primary;
    if (pending.length > 0) {
      const cleanup = new ArtifactOperationError(
        operation,
        "io",
        undefined,
        "Source cleanup remains incomplete",
        {
          cause,
          cleanup: {
            reason: "Source cleanup remains incomplete",
            resources: pending.flatMap((failure) => failure.cleanupResources),
          },
        },
      ).bindCleanupDependencies(pending);
      error = analysisErrorWithCleanupFailure(
        primary,
        cleanup,
        operation,
      ).bindCleanupDependencies([primary, cleanup]);
    }
    for (const failure of secondary) error.retainSecondaryFailure(failure);
    return error;
  }
  if (cause instanceof ArtifactFileCleanupFailure) {
    // An outer close owns only its exact file, not the source's classification
    // or cleanup lifecycle. Preserve that primary through this boundary too.
    const physical = cause.fileCleanupFailure;
    const observation = ArtifactReaderFailure.cleanupObservation(
      physical.cleanupCause,
      physical.path,
    );
    const cleanup = new ArtifactOperationError(
      operation,
      "io",
      undefined,
      observation.reason,
      {
        cause: physical.cleanupCause,
        cleanup: observation,
        ...(cause.partialObservation === undefined
          ? {}
          : { partialObservation: cause.partialObservation }),
      },
    );
    new AnalysisCleanupLeaseGroup(cleanup, [cause.cleanupLease]);
    const primary =
      physical.outcome.kind === "failed"
        ? translateOwnedArtifactFailure(operation, physical.outcome.cause)
        : physical.completionCancellation === undefined
          ? undefined
          : translateArtifactFailure(
              operation,
              new ArtifactReaderFailure(
                "cancelled",
                "Artifact read cancelled during close",
                { cause: physical.completionCancellation.reason },
              ),
            );
    return primary === undefined
      ? cleanup
      : analysisErrorWithCleanupFailure(
          primary,
          cleanup,
          operation,
        ).bindCleanupDependencies([primary, cleanup]);
  }
  if (cause instanceof ArtifactReaderFailure) {
    const error = new ArtifactOperationError(
      operation,
      cause.reason,
      cause.details,
      cause.message,
      {
        cause:
          cause.reason === "cancelled"
            ? artifactFileCancellationCause(cause)
            : cause,
        ...(cause.cleanup === undefined ? {} : { cleanup: cause.cleanup }),
        ...(cause.partialObservation === undefined
          ? {}
          : { partialObservation: cause.partialObservation }),
      },
    );
    bindArtifactFileCleanup(cause, error);
    return error;
  }
  // Caller-selection and unsupported-target failures are already typed; keep
  // their correction details instead of reducing them to an I/O failure.
  if (
    cause instanceof AnalysisInputError ||
    cause instanceof AnalysisCancelledError ||
    cause instanceof AnalysisUnsupportedTargetError
  )
    return cause;
  return new ArtifactOperationError(operation, "io");
};

/** A domain error already owns its live cleanup state; only classify raw errors. */
const translateOwnedArtifactFailure = (
  operation: ArtifactOperationError["operation"],
  cause: unknown,
): AnalysisError =>
  cause instanceof AnalysisError
    ? cause
    : translateArtifactFailure(operation, ArtifactReaderFailure.from(cause));
