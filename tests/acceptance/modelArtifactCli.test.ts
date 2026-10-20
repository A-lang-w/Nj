import { createHash } from "node:crypto";
import { writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { toolContract } from "../../src/contracts/toolContracts.js";
import {
  modelArtifactSchema,
  type ModelArtifact,
} from "../../src/domain/model/modelArtifact.js";
import {
  modelArtifactSummaryViewResultSchema,
  analysisViewResultSchema,
} from "../../src/domain/analysisView/analysisView.js";
import { parseEvidence } from "../../src/domain/evidence.js";
import { readEvidenceBundle } from "../../src/application/EvidenceBundleFiles.js";
import { connectLocalToolsMcp } from "../fixtures/localToolsMcp.js";
import { parseMcpToolError } from "../fixtures/mcpToolError.js";
import { ggufFixture, safetensorsFixture } from "../fixtures/model/model.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest } from "../support/cli/cliFixture.js";

const assertHistoricalModelPages = async (
  call: Awaited<ReturnType<typeof connectLocalToolsMcp>>["call"],
  parentEvidenceId: string,
  report: ModelArtifact,
): Promise<void> => {
  const pages = [];
  for (let offset = 0; offset < report.tensors.length; offset++) {
    const page = await call("inspect_analysis_view", {
      source: {
        kind: "retained-evidence",
        evidence_id: parentEvidenceId,
      },
      view: {
        kind: "model-artifact",
        collection: "tensors",
        offset,
        limit: 1,
        fields: ["type", "shape", "file_offset"],
      },
    });
    expect(page.isError, JSON.stringify(page)).not.toBe(true);
    const selected = analysisViewResultSchema.parse(
      parseEvidence(page.structuredContent).normalized_result,
    );
    if (selected.kind !== "model-artifact") throw new Error("Incorrect view");
    expect(selected.source.header_sha256).toBe(report.artifact.header_sha256);
    expect(selected.source.sha256).toBeNull();
    pages.push(...selected.items);
  }
  expect(pages).toEqual(
    report.tensors.map(({ index, name, type, shape, file_offset }) => ({
      index,
      name,
      type,
      shape,
      file_offset,
    })),
  );
  const selected = await call("inspect_analysis_view", {
    source: {
      kind: "retained-evidence",
      evidence_id: parentEvidenceId,
    },
    view: {
      kind: "model-artifact",
      collection: "tensors",
      names: ["weight", "absent"],
      indices: [0, 1],
      fields: [],
    },
  });
  const selectedView = analysisViewResultSchema.parse(
    parseEvidence(selected.structuredContent).normalized_result,
  );
  if (selectedView.kind !== "model-artifact") throw new Error("Incorrect view");
  expect(selectedView.items).toEqual(
    report.tensors
      .filter((row) => row.name === "weight")
      .map(({ index, name }) => ({ index, name })),
  );
  const empty = await call("inspect_analysis_view", {
    source: {
      kind: "retained-evidence",
      evidence_id: parentEvidenceId,
    },
    view: {
      kind: "model-artifact",
      collection: "metadata",
      keys: [],
      offset: 100,
    },
  });
  expect(empty.isError, JSON.stringify(empty)).not.toBe(true);
  const emptyView = analysisViewResultSchema.parse(
    parseEvidence(empty.structuredContent).normalized_result,
  );
  expect(emptyView.coverage).toMatchObject({ total: 0, exhausted: true });
  const unverified = await call("inspect_analysis_view", {
    source: {
      kind: "retained-evidence",
      evidence_id: parentEvidenceId,
    },
    view: {
      kind: "model-artifact",
      collection: "tensors",
      storage_validation: ["unknown"],
      fields: ["storage_validation", "byte_length"],
    },
  });
  expect(unverified.isError, JSON.stringify(unverified)).not.toBe(true);
  const unverifiedView = analysisViewResultSchema.parse(
    parseEvidence(unverified.structuredContent).normalized_result,
  );
  if (unverifiedView.kind !== "model-artifact")
    throw new Error("Incorrect storage selection");
  expect(unverifiedView.items).toEqual(
    report.tensors
      .filter((row) => row.storage_validation === "unknown")
      .map(({ index, name, storage_validation, byte_length }) => ({
        index,
        name,
        storage_validation,
        byte_length,
      })),
  );
  const histogram = await call("inspect_analysis_view", {
    source: {
      kind: "retained-evidence",
      evidence_id: parentEvidenceId,
    },
    view: {
      kind: "model-artifact",
      collection: "types",
      types: ["F32"],
      fields: ["tensors", "parameter_count", "bytes"],
    },
  });
  expect(histogram.isError, JSON.stringify(histogram)).not.toBe(true);
  const histogramView = analysisViewResultSchema.parse(
    parseEvidence(histogram.structuredContent).normalized_result,
  );
  if (histogramView.kind !== "model-artifact")
    throw new Error("Incorrect histogram view");
  expect(histogramView.items).toEqual(
    report.totals.by_type.flatMap((row, index) =>
      row.type === "F32" ? [{ index, ...row }] : [],
    ),
  );
};

cliTest(
  "shares scoped model facts through real CLI/MCP and pages retained metadata after source removal",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-model-cli-");
    const { call } = await connectLocalToolsMcp();
    for (const [format, fixture] of [
      ["gguf", ggufFixture()],
      ["safetensors", safetensorsFixture()],
      [
        "safetensors",
        safetensorsFixture(
          '{"future":{"dtype":"FUTURE4","shape":[2],"data_offsets":[0,4]}}',
          Buffer.alloc(4),
        ),
      ],
    ] as const) {
      const path = join(root, `${format}.arbitrary`);
      await writeFile(path, fixture.bytes);
      const result = await cli.run({
        arguments: [
          "inspect-model-artifact",
          path,
          "--detail",
          "complete",
          "--json",
        ],
      });
      expect(result.exitCode, result.stderr).toBe(0);
      const evidence = toolContract(
        "inspect_model_artifact",
      ).outputSchema.parse(result.json);
      const report = modelArtifactSchema.parse(evidence.normalized_result);
      expect(report.format).toBe(format);
      expect(report.artifact.sha256).toBeNull();
      expect(evidence.subject).toBeNull();
      const complete = await call("inspect_model_artifact", {
        path,
        detail: "complete",
      });
      expect(complete.isError, JSON.stringify(complete)).not.toBe(true);
      expect(
        parseEvidence(complete.structuredContent).normalized_result,
      ).toEqual(report);
      const hashed = await call("inspect_model_artifact", {
        path,
        detail: "complete",
        hash: "full",
      });
      expect(hashed.isError, JSON.stringify(hashed)).not.toBe(true);
      expect(
        parseEvidence(hashed.structuredContent).subject?.digest.sha256,
      ).toBe(createHash("sha256").update(fixture.bytes).digest("hex"));
      const summary = await call("inspect_model_artifact", { path });
      expect(summary.isError, JSON.stringify(summary)).not.toBe(true);
      const retained = modelArtifactSummaryViewResultSchema.parse(
        parseEvidence(summary.structuredContent).normalized_result,
      );
      expect(retained.summary.counts.tensors).toBe(report.tensors.length);
      const direct = await call("inspect_model_artifact", {
        path,
        view: {
          collection: "tensors",
          names: ["weight"],
          fields: ["type", "shape", "file_offset"],
        },
      });
      expect(direct.isError, JSON.stringify(direct)).not.toBe(true);
      const directView = analysisViewResultSchema.parse(
        parseEvidence(direct.structuredContent).normalized_result,
      );
      if (directView.kind !== "model-artifact")
        throw new Error("Incorrect direct selection");
      expect(directView.model.counts.tensors).toBe(report.tensors.length);
      expect(directView.items).toEqual(
        report.tensors
          .filter((row) => row.name === "weight")
          .map(({ index, name, type, shape, file_offset }) => ({
            index,
            name,
            type,
            shape,
            file_offset,
          })),
      );
      expect(directView.parent_evidence_id).toBe(
        parseEvidence(complete.structuredContent).evidence_id,
      );
      await unlink(path);
      await assertHistoricalModelPages(
        call,
        retained.parent_evidence_id,
        report,
      );
    }
  },
);

cliTest(
  "exports complete model Evidence for portable paging and returns typed malformed errors",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-model-export-");
    const path = join(root, "model");
    const output = join(root, "evidence.json");
    await writeFile(path, ggufFixture().bytes);
    const result = await cli.run({
      arguments: [
        "inspect-model-artifact",
        path,
        "--detail",
        "summary",
        "--view",
        JSON.stringify({
          collection: "metadata",
          keys: ["tokenizer.chat_template"],
          fields: ["value"],
        }),
        "--evidence_output",
        output,
        "--json",
      ],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const receipt = result.json as { summary: unknown };
    const delivered = analysisViewResultSchema.parse(
      parseEvidence(receipt.summary).normalized_result,
    );
    if (delivered.kind !== "model-artifact")
      throw new Error("Missing CLI direct selection");
    expect(delivered.items).toEqual([
      { index: 5, key: "tokenizer.chat_template", value: "{{ messages }}" },
    ]);
    const exported = await readEvidenceBundle(output);
    if (!exported.ok) throw exported.error;
    const complete = exported.value.records.find(
      (evidence) => evidence.operation === "inspect_model_artifact",
    );
    if (complete === undefined)
      throw new Error("Missing complete exported model Evidence");
    const recordPath = join(root, "model-record.json");
    await writeFile(recordPath, JSON.stringify(complete));
    const { call } = await connectLocalToolsMcp();
    await unlink(path);
    const page = await call("inspect_analysis_view", {
      source: { kind: "evidence-file", path: recordPath },
      view: {
        kind: "model-artifact",
        collection: "metadata",
        keys: ["tokenizer.chat_template", "custom.exact"],
        fields: ["type", "value", "source_offset", "source_length"],
      },
    });
    expect(page.isError, JSON.stringify(page)).not.toBe(true);
    const selected = analysisViewResultSchema.parse(
      parseEvidence(page.structuredContent).normalized_result,
    );
    if (selected.kind !== "model-artifact") throw new Error("Incorrect view");
    expect(selected.items.map((row) => ("key" in row ? row.key : ""))).toEqual([
      "custom.exact",
      "tokenizer.chat_template",
    ]);
    await writeFile(
      path,
      safetensorsFixture(
        '{"x":{"dtype":"F32","shape":[3],"data_offsets":[4,16]}}',
      ).bytes,
    );
    const malformed = parseMcpToolError(
      await call("inspect_model_artifact", { path }),
    );
    expect(malformed.error).toMatchObject({
      code: "target_unavailable",
      category: "unsupported_target",
      details: { constraint: "file_format_rejected" },
    });
  },
);
