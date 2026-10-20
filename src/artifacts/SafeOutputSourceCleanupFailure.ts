import {
  ArtifactReaderFailure,
  artifactPrimaryCleanupLeases,
} from "./ArtifactReader.js";

/** Preserve every source failure, even when their combined cleanup owner is unknown. */
export class SafeOutputSourceCleanupFailure extends ArtifactReaderFailure {
  readonly sourceFailures: readonly unknown[];

  constructor(primary: unknown, sourceFailures: readonly unknown[]) {
    const observations = sourceFailures.map((failure) =>
      ArtifactReaderFailure.cleanupObservation(failure, []),
    );
    const inherited = artifactPrimaryCleanupLeases(primary);
    const sourceLeases = sourceFailures.map((failure) =>
      failure instanceof ArtifactReaderFailure && failure.cleanup !== undefined
        ? failure.cleanupLeases
        : undefined,
    );
    const projected = ArtifactReaderFailure.withCleanup(
      primary,
      {
        reason: observations.map(({ reason }) => reason).join("; "),
        resources: [
          ...new Set(observations.flatMap(({ resources }) => resources)),
        ],
      },
      undefined,
      inherited === undefined ||
        sourceLeases.some((leases) => leases === undefined)
        ? undefined
        : [
            ...new Set([
              ...inherited,
              ...sourceLeases.flatMap((leases) => leases ?? []),
            ]),
          ],
    );
    super(
      projected.reason,
      projected.message,
      {
        cause: projected.cause,
        cancellation: projected.cancellation,
        cleanup: projected.cleanup,
        cleanupLeases: projected.cleanupLeases,
        partialObservation: projected.partialObservation,
        ...(projected.boundary === undefined
          ? {}
          : { boundary: projected.boundary }),
      },
      projected.details,
    );
    // Individual producers still retain their exact leases when the combined
    // observation also contains a failure with no known cleanup authority.
    this.sourceFailures = [...sourceFailures];
  }
}
