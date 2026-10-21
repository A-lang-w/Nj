import { expect, it } from "vitest";
import { ArtifactReaderFailure } from "../../artifacts/ArtifactReader.js";
import { projectAnalysisError } from "../../domain/analysisErrorProjection.js";
import { OwnedCommandFailure } from "../../process/OwnedCommand.js";
import { pwntoolsDecoderFailure } from "./PwntoolsFailures.js";

it.each([undefined, null, false, 0, "stop", { stop: true }, new Error("stop")])(
  "preserves opaque cancellation from command and artifact owners: %s",
  (reason) => {
    for (const failure of [
      new OwnedCommandFailure("cancelled", "cancelled", null, null, {
        cause: new Error("transport wrapper"),
        cancellation: { reason },
      }),
      new ArtifactReaderFailure("cancelled", "cancelled", {
        cause: new Error("file wrapper"),
        cancellation: { reason },
      }),
    ]) {
      const result = pwntoolsDecoderFailure(failure, "decoder", "/selected");
      expect(result._tag).toBe("AnalysisCancelledError");
      expect(result.cause).toBe(reason);
      expect(Object.hasOwn(result, "cause")).toBe(true);
    }
  },
);

it("names pwntools_timeout_ms and leaves cpuSeconds and byte allowances fixed", () => {
  const projected = projectAnalysisError(
    pwntoolsDecoderFailure(
      new OwnedCommandFailure("timeout", "deadline expired"),
      "decoder",
      "/selected",
      "/python",
      {},
      {
        operation: "inspect_binary_layout",
        providerId: "pwntools",
        timeoutMs: 4_500,
      },
    ),
  );
  expect(projected.code).toBe("provider_timeout");
  expect(projected.message).toContain("4500 ms");
  expect(projected.message).toContain("pwntools_timeout_ms");
  expect(projected.remediation.action).toContain("--pwntools-timeout-ms");
  expect(projected.remediation.action).toContain("cpuSeconds is 30");
  expect(projected.remediation.action).toContain("no runtime override");
  expect(projected.remediation.action).toContain("67108864");
});

it("retains legacy owner causes without guessing cancellation from error text", () => {
  const reason = { stop: "legacy" };
  const result = pwntoolsDecoderFailure(
    new OwnedCommandFailure("cancelled", "cancelled", null, null, {
      cause: reason,
    }),
    "decoder",
    "/selected",
  );
  expect(result.cause).toBe(reason);
  const physical = Object.assign(new Error("physical failure"), {
    name: "AbortError",
  });
  expect(pwntoolsDecoderFailure(physical, "decoder", "/selected")._tag).toBe(
    "ProviderAdapterError",
  );
});
