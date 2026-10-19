import { mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { z } from "zod";

import { parseApplicationGraphEvidence } from "../../../src/application/javascript/JavaScriptApplicationEvidenceGraph.js";
import { createEvidence, parseEvidence } from "../../../src/domain/evidence.js";
import { parseEvidenceBundle } from "../../../src/domain/evidenceBundle.js";
import { javascriptApplicationAnalysisResultSchema } from "../../../src/domain/javascript/javascriptApplicationAnalysis.js";
import { connectLocalToolsMcp } from "../../fixtures/localToolsMcp.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

const linkedApplication = async () => {
  const root = await createTestTempDirectory("rea-js-input-path-");
  const physical = join(root, "physical");
  const selected = join(root, "selected app");
  await mkdir(physical);
  await writeFile(join(physical, "index.mjs"), "export const result = 7;\n");
  await symlink(
    physical,
    selected,
    process.platform === "win32" ? "junction" : "dir",
  );
  return { root, selected, canonical: await realpath(selected) };
};

cliTest.for(["analyze-javascript-application", "analyze"])(
  "%s retains the selected relative alias separately from artifact identity",
  async (command, { cli }) => {
    const { root, canonical } = await linkedApplication();
    const selected = "./selected app";
    const response = await cli.run({
      arguments: [command, selected, "--format", "json"],
      cwd: root,
    });
    expect(response.exitCode, response.stdout + response.stderr).toBe(0);
    const evidence = parseEvidence(response.json);
    const result = javascriptApplicationAnalysisResultSchema.parse(
      evidence.normalized_result,
    );
    expect(evidence.subject?.local_path).toBe(canonical);
    expect(result.input_path).toBe(canonical);
    expect(evidence.parameters.input_path).toBe(selected);
  },
);

it("retains the absolute MCP alias without changing artifact identity or rereading historical paths", async () => {
  const { selected, canonical } = await linkedApplication();
  const { call } = await connectLocalToolsMcp();
  const observed = await call("analyze_javascript_application", {
    input_path: selected,
  });
  expect(observed.isError, JSON.stringify(observed.content)).not.toBe(true);
  const evidence = parseEvidence(observed.structuredContent);
  const result = javascriptApplicationAnalysisResultSchema.parse(
    evidence.normalized_result,
  );
  const control = await call("analyze_javascript_application", {
    input_path: canonical,
  });
  expect(control.isError, JSON.stringify(control.content)).not.toBe(true);
  const canonicalEvidence = parseEvidence(control.structuredContent);
  expect(evidence.subject?.local_path).toBe(canonical);
  expect(result.input_path).toBe(canonical);
  expect(evidence.parameters.input_path).toBe(selected);
  expect(canonicalEvidence.parameters.input_path).toBe(canonical);
  expect(evidence.subject).toEqual(canonicalEvidence.subject);
  expect(evidence.normalized_result).toEqual(
    canonicalEvidence.normalized_result,
  );
  expect(evidence.evidence_id).not.toBe(canonicalEvidence.evidence_id);

  await rm(selected);
  await rm(canonical, { recursive: true });
  const response = await call("get_evidence_bundle", { detail: "complete" });
  expect(response.isError, JSON.stringify(response.content)).not.toBe(true);
  const bundleEnvelope = z
    .object({ result: z.unknown() })
    .parse(response.structuredContent);
  const bundle = parseEvidenceBundle(bundleEnvelope.result);
  const retained = bundle.records.find(
    (record) => record.evidence_id === evidence.evidence_id,
  );
  expect(retained).toEqual(evidence);
  const parsed = parseApplicationGraphEvidence(retained);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.error));
  expect(parsed.value.evidence.parameters.input_path).toBe(selected);
  expect(parsed.value.graph).toEqual(result.graph);

  // Previously exported records omit the caller path. They must remain readable
  // using their recorded artifact identity, even after the artifact is gone.
  const legacy = createEvidence(
    {
      path: canonical,
      sha256: result.root_artifact_sha256,
      format: result.format,
    },
    evidence.provider,
    {
      predicateType: evidence.predicate_type,
      operation: evidence.operation,
      parameters: Object.fromEntries(
        Object.entries(evidence.parameters).filter(
          ([key]) => key !== "input_path",
        ),
      ),
      result: evidence.normalized_result,
      confidence: evidence.confidence,
      authority: evidence.authority,
      limitations: evidence.limitations,
      locations: evidence.locations,
    },
  );
  const parsedLegacy = parseApplicationGraphEvidence(
    JSON.parse(JSON.stringify(legacy)),
  );
  if (!parsedLegacy.ok) throw new Error(JSON.stringify(parsedLegacy.error));
  expect(parsedLegacy.value.graph).toEqual(result.graph);
  expect(parsedLegacy.value.evidence.parameters).not.toHaveProperty(
    "input_path",
  );
}, 60_000);
