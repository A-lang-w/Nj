import { expect, it } from "vitest";
import { AnalysisResourceConstraintError } from "../../domain/analysisErrorCore.js";
import { analyzeJavaScriptSemantics } from "../../domain/javascript/javascriptSemanticAnalysis.js";
import { projectJavaScriptModuleSemantics } from "../../domain/javascript/javascriptModuleSemanticIr.js";
import { projectAnalysisError } from "../../domain/analysisErrorProjection.js";
import {
  javaScriptForwardedTransferRemediation,
  measureJavaScriptModuleTransfer,
} from "./JavaScriptAnalysisTransfer.js";

it("says a transfer ceiling has no runtime override and is not raised by max_heap_mb", () => {
  const ir = analyzeJavaScriptSemantics(
    "export function add(value) { return value + 1; }",
  );
  const module = projectJavaScriptModuleSemantics(ir);
  const measured = measureJavaScriptModuleTransfer(module);
  let caught: unknown;
  try {
    measureJavaScriptModuleTransfer(module, measured.bytes - 1);
  } catch (cause) {
    caught = cause;
  }
  if (!(caught instanceof AnalysisResourceConstraintError))
    throw new Error("Expected a transfer ceiling refusal");
  const projected = projectAnalysisError(caught);
  expect(projected.message).toContain("no runtime override");
  expect(projected.message).toContain(
    String(caught.reportedLimits?.transfer_file_bytes),
  );
  expect(projected.remediation.action).toContain("no runtime override");
  expect(projected.remediation.action).toContain("max_heap_mb");
  expect(projected.remediation.action).toContain("8388608");
  expect(projected.remediation.action).toContain("2147483648");
  expect(projected.remediation.action).not.toContain("get_evidence_bundle");
  expect(
    javaScriptForwardedTransferRemediation(caught.reportedLimits),
  ).toContain("no runtime override");
});
