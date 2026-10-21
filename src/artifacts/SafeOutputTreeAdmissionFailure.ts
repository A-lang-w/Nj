import {
  ArtifactReaderFailure,
  type ArtifactReaderFailureOptions,
} from "./ArtifactReader.js";

/** Destination admission failed before an owned tree was acquired. */
export class SafeOutputTreeAdmissionFailure extends ArtifactReaderFailure {
  constructor(
    reason: "path" | "unavailable",
    message: string,
    options?: ArtifactReaderFailureOptions,
  ) {
    super(reason, message, options);
    this.name = "SafeOutputTreeAdmissionFailure";
  }
}
