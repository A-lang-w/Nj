import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { createEvidence } from "../domain/evidence.js";
import { createEvidenceBundle } from "../domain/evidenceBundle.js";
import type { JsonValue } from "../domain/jsonValue.js";
import {
  build,
  readyProcessLedgerRequest,
} from "./ReconstructionObligationLedger.fixture.js";

const ORIGINAL = createHash("sha256").update("hello ordinary").digest("hex");
const CORRUPTED = createHash("sha256").update("CORRUPTED").digest("hex");

// Synthetic Evidence with digests of actual small strings; no Docker execution.
const fixtureControlRequest = (
  positive: (ids: string[]) => JsonValue,
  control: JsonValue,
  reportedFixtureId?: string,
) => {
  const input = readyProcessLedgerRequest();
  const binding = input.manifest.bindings[0]!;
  const verifier = binding.verifier!;
  const negative = verifier.negative_controls![0]!;
  const replacements = new Map<string, string>();
  const records = input.evidence_bundle.records.map((record) => {
    if (
      record.evidence_id !== verifier.result_evidence_id &&
      record.evidence_id !== negative.result_evidence_id
    )
      return record;
    const result = record.normalized_result;
    if (result === null || typeof result !== "object" || Array.isArray(result))
      throw new Error("Expected proof result");
    const replacement = createEvidence(undefined, record.provider, {
      predicateType: record.predicate_type,
      operation: record.operation,
      parameters: record.parameters,
      result: {
        ...result,
        ...(record.evidence_id === verifier.result_evidence_id &&
        reportedFixtureId !== undefined
          ? {
              fixture_ids: [
                ...binding.fixtures.map(({ fixture_id }) => fixture_id),
                reportedFixtureId,
              ],
            }
          : {}),
        fixture_sha256s:
          record.evidence_id === verifier.result_evidence_id
            ? positive(binding.fixtures.map(({ fixture_id }) => fixture_id))
            : control,
      },
      confidence: record.confidence,
      authority: record.authority,
    });
    replacements.set(record.evidence_id, replacement.evidence_id);
    return replacement;
  });
  input.evidence_bundle = createEvidenceBundle(records);
  verifier.result_evidence_id = replacements.get(verifier.result_evidence_id)!;
  negative.result_evidence_id = replacements.get(negative.result_evidence_id)!;
  for (const fixture of binding.fixtures)
    fixture.evidence_ids = fixture.evidence_ids.map(
      (id) => replacements.get(id) ?? id,
    );
  return input;
};

const originals = (ids: string[]) =>
  Object.fromEntries(ids.map((id) => [id, ORIGINAL]));
const controlDigest = (digest: JsonValue) => ({
  "packaged.deliberate-defect": digest,
});

describe("fixture control content identity", () => {
  it.each(["missing", "reused"])(
    "checks %s contents of a positive fixture reported only by the verifier",
    (kind) => {
      const input = fixtureControlRequest(
        (ids) => ({
          ...originals(ids),
          ...(kind === "reused" ? { "reported-only": CORRUPTED } : {}),
        }),
        controlDigest(CORRUPTED),
        "reported-only",
      );
      const ledger = build(input);
      expect(ledger.status).toBe("open");
      expect(ledger.obligations[0]?.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "invalid-control-candidate",
            detail: expect.stringContaining("reported-only"),
          }),
        ]),
      );
    },
  );

  it("accepts a changed copy with a recorded behavior mismatch", () => {
    const ledger = build(
      fixtureControlRequest(originals, controlDigest(CORRUPTED)),
    );
    expect(ledger.status).toBe("ready");
    expect(ledger.obligations[0]?.status).toBe("verified");
  });

  it.each([
    ["renamed but identical contents", originals, controlDigest(ORIGINAL)],
    ["missing positive digests", () => ({}), controlDigest(CORRUPTED)],
    ["missing control digest", originals, {}],
    [
      "digest under the wrong control name",
      originals,
      { unrelated: CORRUPTED },
    ],
    ["malformed control digest", originals, controlDigest("not-a-sha256")],
    [
      "malformed positive digest",
      (ids: string[]) => ({ ...originals(ids), [ids[0]!]: "invalid" }),
      controlDigest(CORRUPTED),
    ],
    [
      "partly identified positive fixtures",
      (ids: string[]) => ({ [ids[0]!]: ORIGINAL }),
      controlDigest(CORRUPTED),
    ],
    [
      "contents reused from a later positive fixture",
      (ids: string[]) => ({ ...originals(ids), [ids.at(-1)!]: CORRUPTED }),
      controlDigest(CORRUPTED),
    ],
  ] as const)("keeps closure open for %s", (_name, positive, control) => {
    const ledger = build(fixtureControlRequest(positive, control));
    expect(ledger.status).toBe("open");
    expect(ledger.obligations[0]?.status).toBe("implemented");
    expect(
      ledger.obligations[0]?.diagnostics.map(({ code }) => code),
    ).toContain("invalid-control-candidate");
  });
});
