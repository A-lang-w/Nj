import { expect, it } from "vitest";
import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import { appleDispatchMetadataFailure } from "./AppleDispatchMetadata.js";

it.each(["integrity", "path"] as const)(
  "keeps %s bound-target refusals distinct from provider execution failures",
  (reason) => {
    const cause = new ArtifactReaderFailure(reason, "source boundary refused");
    expect(appleDispatchMetadataFailure(cause, "/selected")._tag).toBe(
      "AnalysisArtifactChangedError",
    );
  },
);
it.each(["EACCES", "EPERM", "ENOENT"])(
  "preserves the filesystem outcome %s for a bound metadata target",
  (code) => {
    const physical = Object.assign(new Error("selected read refused"), {
      code,
    });
    const cause = new ArtifactReaderFailure("io", "could not read", {
      cause: physical,
    });
    expect(appleDispatchMetadataFailure(cause, "/selected")._tag).toBe(
      code === "ENOENT"
        ? "AnalysisArtifactChangedError"
        : "AnalysisAccessDeniedError",
    );
  },
);
