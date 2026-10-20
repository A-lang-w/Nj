import { expect, it } from "vitest";
import { AnalysisCancelledError } from "../domain/analysisErrorCore.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { firmwareRequestSchema } from "../domain/firmware/firmwareAnalysis.js";
import { firmwareFailure } from "./FirmwareFailures.js";

it("defaults and preserves the caller's publication budget at the shared contract", () => {
  const parse = (input: Record<string, unknown>) =>
    firmwareRequestSchema.parse({
      operation: "extract_firmware",
      input: { path: "/firmware.bin", output_directory: "/output", ...input },
    });
  expect(parse({}).input).toMatchObject({ publication_timeout_ms: 120_000 });
  expect(parse({ publication_timeout_ms: 345_678 }).input).toMatchObject({
    publication_timeout_ms: 345_678,
  });
  for (const value of [0, -1, 0.5, 2_147_483_648, null, "120000"])
    expect(() => parse({ publication_timeout_ms: value })).toThrow();
});

it("reports the publication phase, verified progress and its selected budget", () => {
  const reason = new Error("deadline");
  const failure = firmwareFailure(
    new AnalysisCancelledError("extract_firmware", { cause: reason }),
    {
      engine: "unblob",
      operation: "extract_firmware",
      deadline: {
        phase: "publication",
        signal: AbortSignal.abort(reason),
        timeoutMs: 345_678,
      },
      publication: {
        output_directory: "/output",
        verified_files: 2,
        total_files: 10,
      },
    },
  );
  expect(projectAnalysisError(failure)).toMatchObject({
    code: "provider_timeout",
    details: {
      timeout_ms: 345_678,
      diagnostics: {
        phase: "publication",
        publication: {
          output_directory: "/output",
          verified_files: 2,
          total_files: 10,
        },
      },
    },
    remediation: { action: expect.stringContaining("publication_timeout_ms") },
  });
});

it("keeps a distinct caller cancellation when the phase deadline has also expired", () => {
  const reason = { caller: "stop" };
  const original = new AnalysisCancelledError("extract_firmware", {
    cause: reason,
  });
  expect(
    firmwareFailure(original, {
      engine: "unblob",
      operation: "extract_firmware",
      deadline: {
        phase: "publication",
        signal: AbortSignal.abort(new Error("late timeout")),
        timeoutMs: 345_678,
      },
    }),
  ).toBe(original);
});
