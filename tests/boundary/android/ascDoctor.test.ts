import { expect, it, vi } from "vitest";
import { AscProvider } from "../../../src/android/AscProvider.js";
import { inspectAscProvider } from "../../../src/android/AscDoctor.js";

it.each([
  ["unsupported_host", "unsupported_host", "Linux"],
  ["open_options_invalid", "config_drift", "Correct"],
  ["runtime_unavailable", "runtime_failure", "Inspect"],
  ["not_configured", "missing_dependency", "REA_ASC_PYTHON"],
] as const)(
  "preserves %s rather than relabeling every failure as a missing dependency",
  async (code, classification, remediation) => {
    const inspected = vi
      .spyOn(AscProvider.prototype, "inspectAvailability")
      .mockResolvedValue({
        status: "unavailable",
        code,
        reason: "producer-owned reason",
        diagnostics: { failure_stage: "fixture" },
      });
    const retained: unknown[] = [];
    try {
      const report = await inspectAscProvider(
        {},
        {
          retain: (owner) => {
            retained.push(owner);
          },
          run: (work) => work(),
        },
      );
      expect(report.checks[0]).toMatchObject({
        code,
        classification,
        detail: "producer-owned reason",
        remediation: expect.stringContaining(remediation),
      });
      expect(retained).toEqual([]);
    } finally {
      inspected.mockRestore();
    }
  },
);
