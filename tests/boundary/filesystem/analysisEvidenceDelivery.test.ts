import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { expect, it, vi } from "vitest";

import { runWithAnalysisEvidenceDelivery } from "../../../src/application/analysisView/AnalysisEvidenceDelivery.js";
import { AnalysisInputError } from "../../../src/domain/analysisErrorCore.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { parseEvidenceBundle } from "../../../src/domain/evidenceBundle.js";
import { err, ok } from "../../../src/domain/result.js";
import { OwnedStagedOutput } from "../../../src/filesystem/OwnedStagedOutput.js";
import { analysisViewLayoutEvidence } from "../../fixtures/analysisView.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

it.each(["complete", "summary"] as const)(
  "retains completed Evidence and the exact cancellation reason before %s delivery",
  async (detail) => {
    const root = await createTestTempDirectory("rea-delivery-cancel-");
    const parent = analysisViewLayoutEvidence();
    const controller = new AbortController();
    const reason = new Error("cancelled after analysis cleanup");
    const result = await runWithAnalysisEvidenceDelivery(
      parent.operation,
      {
        detail,
        ...(detail === "summary"
          ? { evidenceBundlePath: join(root, "bundle.json") }
          : {}),
      },
      async () => {
        controller.abort(reason);
        return ok(parent);
      },
      controller.signal,
    );
    if (result.ok) throw new Error("Cancelled delivery reported success");
    expect(result.error._tag).toBe("AnalysisCancelledError");
    expect(result.error.cause).toBe(reason);
    expect(result.error.partialObservation).toBe(parent);
    expect(await readdir(root)).toEqual([]);
  },
);

it("preserves a provider failure when cancellation also arrives before delivery", async () => {
  const controller = new AbortController();
  const failure = new AnalysisInputError("inspect_managed_members", undefined, [
    { path: ["path"], reason: "invalid_format" },
  ]);
  const result = await runWithAnalysisEvidenceDelivery(
    "inspect_managed_members",
    {},
    async () => {
      controller.abort(new Error("later cancellation"));
      return err(failure);
    },
    controller.signal,
  );
  if (result.ok) throw new Error("Failed analysis reported success");
  expect(result.error).toBe(failure);
});

it("retains the committed bundle receipt when cancellation arrives during final cleanup", async () => {
  const root = await createTestTempDirectory("rea-delivery-published-cancel-");
  const path = join(root, "bundle.json");
  const parent = analysisViewLayoutEvidence();
  const controller = new AbortController();
  const reason = new Error("cancel after actual staged-output cleanup");
  const close = OwnedStagedOutput.prototype.close;
  const seam = vi
    .spyOn(OwnedStagedOutput.prototype, "close")
    .mockImplementationOnce(async function (this: OwnedStagedOutput) {
      await close.call(this);
      controller.abort(reason);
    });
  let result: Awaited<ReturnType<typeof runWithAnalysisEvidenceDelivery>>;
  try {
    result = await runWithAnalysisEvidenceDelivery(
      parent.operation,
      { detail: "summary", evidenceBundlePath: path },
      async () => ok(parent),
      controller.signal,
    );
  } finally {
    seam.mockRestore();
  }
  if (result.ok) throw new Error("Cancelled delivery reported success");
  expect(result.error._tag).toBe("AnalysisCancelledError");
  expect(result.error.cause).toBe(reason);
  const bytes = await readFile(path);
  expect(result.error.diagnostics?.evidence_bundle).toEqual({
    path,
    bytes: bytes.length,
  });
  expect(parseEvidence(result.error.partialObservation).evidence_links).toEqual(
    [parent.evidence_id],
  );
  expect(
    parseEvidenceBundle(JSON.parse(bytes.toString("utf8"))).records[0]
      ?.evidence_id,
  ).toBe(parent.evidence_id);
  expect(await readdir(root)).toEqual(["bundle.json"]);
});
