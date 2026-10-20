import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { cliTest } from "../../support/cli/cliFixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { connectLocalToolsMcp } from "../../fixtures/localToolsMcp.js";
import {
  nativeMatchingInventory,
  nativeMatchingDetails,
} from "../../fixtures/nativeFunctionMatching.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import {
  createEvidenceBundle,
  parseEvidenceBundle,
} from "../../../src/domain/evidenceBundle.js";
import { nativeFunctionMatchingSchema } from "../../../src/domain/native/functionMatching.js";

cliTest(
  "shared public CLI/MCP matching retains sources, pages exact facts, and feeds selected dossier pairs directly to compare_functions",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-native-matching-");
    const left = nativeMatchingInventory("1", [
      { address: "0x10", value: "main" },
      { address: "0x20", value: "old_name" },
    ]);
    const right = nativeMatchingInventory("2", [
      { address: "0x30", value: "main" },
      { address: "0x40", value: "new_name" },
    ]);
    const leftDetails = [
      ...nativeMatchingDetails("1", "0x10", "9000", true),
      ...nativeMatchingDetails("1", "0x20", "c3", true),
    ];
    const rightDetails = [
      ...nativeMatchingDetails("2", "0x30", "9001", true),
      ...nativeMatchingDetails("2", "0x40", "c3", true),
    ];
    const { call } = await connectLocalToolsMcp();
    const full = await call("match_native_functions", {
      left,
      right,
      left_observations: leftDetails,
      right_observations: rightDetails,
      detail: "complete",
    });
    expect(full.isError, JSON.stringify(full)).not.toBe(true);
    const evidence = parseEvidence(full.structuredContent),
      report = nativeFunctionMatchingSchema.parse(evidence.normalized_result);
    expect(report.summary).toEqual({
      matched: 2,
      only_left: 0,
      only_right: 0,
      unresolved: 0,
    });
    const reference = (evidence_id: string) => ({
      kind: "retained-evidence",
      evidence_id,
    });
    const input = {
      left: reference(left.evidence_id),
      right: reference(right.evidence_id),
      left_observations: leftDetails.map((x) => reference(x.evidence_id)),
      right_observations: rightDetails.map((x) => reference(x.evidence_id)),
    };
    const summary = await call("match_native_functions", input);
    expect(summary.isError, JSON.stringify(summary)).not.toBe(true);
    expect(
      parseEvidence(summary.structuredContent).normalized_result,
    ).toMatchObject({
      kind: "summary",
      parent_evidence_id: evidence.evidence_id,
      summary: { summary: report.summary },
    });
    const page = await call("inspect_analysis_view", {
      source: reference(evidence.evidence_id),
      view: {
        kind: "function-matches",
        collection: "functions",
        sides: ["left"],
        fields: ["name", "body_sha256"],
        offset: 1,
        limit: 1,
      },
    });
    expect(page.isError, JSON.stringify(page)).not.toBe(true);
    expect(
      parseEvidence(page.structuredContent).normalized_result,
    ).toMatchObject({
      coverage: { total: 2, next_offset: null },
      items: [
        {
          name: "old_name",
          function_id: `${left.evidence_id}/1`,
          address: "0x20",
        },
      ],
    });
    const compared = await call(
      "compare_functions",
      report.matches[0]!.compare_functions_input!,
    );
    expect(compared.isError, JSON.stringify(compared)).not.toBe(true);
    expect(parseEvidence(compared.structuredContent).operation).toBe(
      "compare_functions",
    );
    const bundlePath = join(root, "sources.json"),
      inputPath = join(root, "request.json"),
      outputPath = join(root, "result.json");
    await writeFile(
      bundlePath,
      JSON.stringify(
        createEvidenceBundle([left, right, ...leftDetails, ...rightDetails]),
      ),
    );
    const original = await readFile(bundlePath);
    await writeFile(
      inputPath,
      JSON.stringify({ ...input, detail: "complete" }),
    );
    const cliFull = await cli.run({
      arguments: [
        "match-native-functions",
        inputPath,
        "--source_bundle",
        bundlePath,
        "--json",
      ],
    });
    expect(cliFull.exitCode, cliFull.stderr).toBe(0);
    expect(parseEvidence(cliFull.json).evidence_id).toBe(evidence.evidence_id);
    await writeFile(inputPath, JSON.stringify(input));
    const cliSummary = await cli.run({
      arguments: [
        "match-native-functions",
        inputPath,
        "--source_bundle",
        bundlePath,
        "--evidence_output",
        outputPath,
        "--json",
      ],
    });
    expect(cliSummary.exitCode, cliSummary.stderr).toBe(0);
    expect(cliSummary.json).toMatchObject({
      summary: {
        normalized_result: { parent_evidence_id: evidence.evidence_id },
      },
      evidence_bundle: { path: outputPath },
    });
    const bundle = parseEvidenceBundle(
      JSON.parse(await readFile(outputPath, "utf8")),
    );
    const ids = new Set(bundle.records.map((x) => x.evidence_id));
    for (const id of evidence.evidence_links) expect(ids.has(id)).toBe(true);
    expect(ids.has(evidence.evidence_id)).toBe(true);
    expect(await readFile(bundlePath)).toEqual(original);
    const missing = await call("match_native_functions", {
      left: reference(`ev_${"a".repeat(64)}`),
      right: reference(right.evidence_id),
    });
    expect(missing.isError).toBe(true);
  },
  60000,
);
