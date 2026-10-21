import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { createEvidence } from "../domain/evidence.js";
import { createEvidenceBundle } from "../domain/evidenceBundle.js";
import { readEvidenceBundle } from "./EvidenceBundleFiles.js";

// The real budget, measured against a heap that cannot hold any bundle.
vi.mock("./EvidenceAuthenticationHeadroom.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("./EvidenceAuthenticationHeadroom.js")
    >();
  return {
    ...actual,
    requireAuthenticationHeadroom: (
      value: unknown,
      path: string,
      operation: string,
    ) => actual.requireAuthenticationHeadroom(value, path, operation, 1024),
  };
});

describe("evidence bundle import headroom", () => {
  it("refuses to authenticate a bundle the live heap cannot hold", async () => {
    const path = join(
      await createTestTempDirectory("rea-evidence-bundle-headroom-"),
      "bundle.json",
    );
    const record = createEvidence(
      undefined,
      { id: "fixture", name: "Fixture", version: "1" },
      {
        operation: "observe",
        parameters: {},
        result: { text: "y".repeat(10_000) },
      },
    );
    await writeFile(path, JSON.stringify(createEvidenceBundle([record])));
    expect(await readEvidenceBundle(path)).toMatchObject({
      ok: false,
      error: {
        _tag: "AnalysisResourceConstraintError",
        operation: "import_evidence_bundle",
        resource: "memory",
        reportedLimits: {
          input_path: path,
          parsed_copies: 2,
          serialized_copies: 2,
          available_heap_bytes: 1024,
        },
      },
    });
  });
});
