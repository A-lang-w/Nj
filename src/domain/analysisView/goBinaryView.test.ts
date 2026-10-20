import { expect, it } from "vitest";
import { createEvidence } from "../evidence.js";
import type { GoBinary } from "../go/goBinary.js";
import {
  projectAnalysisView,
  type AnalysisViewParent,
} from "./analysisView.js";

const report: GoBinary = {
  artifact: { path: "/artifacts/program", sha256: "a".repeat(64), bytes: 512 },
  format: "elf",
  architecture: "amd64",
  bits: 64,
  byte_order: "little",
  build_info: null,
  limitations: [],
};
const parent = (): AnalysisViewParent => {
  const evidence = createEvidence(
    {
      path: report.artifact.path,
      sha256: report.artifact.sha256,
      format: "elf",
    },
    {
      id: "go-build-info",
      name: "REA Go build-information reader",
      version: "1",
    },
    {
      operation: "inspect_go_binary",
      parameters: { path: report.artifact.path },
      result: report,
      confidence: "observed",
    },
  );
  return {
    evidenceId: evidence.evidence_id,
    operation: evidence.operation,
    subject: evidence.subject,
    normalizedResult: structuredClone(report),
    limitations: [],
  };
};

it("validates mutable inline reports again after an earlier successful view", () => {
  const mutable = structuredClone(report);
  const input = { ...parent(), normalizedResult: mutable };
  expect(projectAnalysisView(input, { kind: "summary" }).ok).toBe(true);
  mutable.artifact.bytes = -1;
  expect(
    projectAnalysisView({ ...input, sealedResult: true }, { kind: "summary" })
      .ok,
  ).toBe(false);
});

it("bounds inherited messages while keeping their complete parent reference", () => {
  const note = "Large source note: " + "x".repeat(300_000);
  const input = {
    ...parent(),
    limitations: [note],
  };
  const result = projectAnalysisView(input, { kind: "summary" });
  expect(result.ok).toBe(true);
  if (!result.ok) throw result.error;
  expect(result.value.limitations.join(" ")).toContain(input.evidenceId);
  expect(result.value.limitations.join(" ")).toContain("omitted");
  expect(result.value.unknowns.join(" ")).toContain("runtime dependencies");
  expect(input.limitations[0]).toBe(note);
});

it.each(["path", "digest", "format"] as const)(
  "rejects a Go parent whose authenticated %s conflicts with its report",
  (field) => {
    const input = parent();
    if (input.subject == null) throw new Error("Expected artifact subject");
    const subject = {
      ...input.subject,
      ...(field === "path" ? { local_path: "/artifacts/other" } : {}),
      ...(field === "digest" ? { digest: { sha256: "b".repeat(64) } } : {}),
    };
    const result = projectAnalysisView(
      {
        ...input,
        subject,
        ...(field === "format"
          ? { normalizedResult: { ...report, format: "pe" } }
          : {}),
      },
      { kind: "summary" },
    );
    expect(result.ok).toBe(false);
  },
);
