import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { expect } from "vitest";

import { parseEvidence } from "../../src/domain/evidence.js";
import { analysisViewJavaScriptEvidence } from "../fixtures/analysisView.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest } from "../support/cli/cliFixture.js";

cliTest(
  "exports authenticated analysis-view rows, preserving every Evidence fact and empty/partial coverage",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-json-lines-view-");
    const parent = analysisViewJavaScriptEvidence();
    const evidencePath = join(root, "parent.json");
    const requestPath = join(root, "request.json");
    await writeFile(evidencePath, JSON.stringify(parent));
    const request = {
      source: { kind: "evidence-file", path: evidencePath },
      view: { kind: "javascript-facts", property_keys: [], limit: 1 },
    };
    await writeFile(requestPath, JSON.stringify(request));

    const invalid = await cli.run({
      arguments: ["inspect-analysis-view", "--format", "jsonl"],
    });
    expect(invalid.exitCode).toBe(1);
    expect(JSON.parse(invalid.stdout)).toMatchObject({
      $rea: "jsonl/v1",
      type: "error",
      result: { code: "VALIDATION_ERROR" },
    });

    const badOutputValue = await cli.run({
      arguments: ["--format", "jsonl", "--token-limit", "invalid"],
    });
    expect(badOutputValue.exitCode).toBe(1);
    expect(JSON.parse(badOutputValue.stdout)).toMatchObject({
      $rea: "jsonl/v1",
      type: "error",
    });

    for (const where of [undefined, { paths: [] }]) {
      await writeFile(
        requestPath,
        JSON.stringify({
          ...request,
          view: { ...request.view, ...(where === undefined ? {} : { where }) },
        }),
      );
      const json = await cli.run({
        arguments: ["inspect-analysis-view", requestPath, "--json"],
      });
      expect(json.exitCode, json.stderr).toBe(0);
      const expected = parseEvidence(json.json);
      const result = await cli.run({
        arguments: ["inspect-analysis-view", requestPath, "--format", "jsonl"],
      });
      expect(result.exitCode, result.stderr).toBe(0);
      const records = result.stdout
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
      const final = records.pop();
      expect(final).toMatchObject({
        $rea: "jsonl/v1",
        type: "metadata",
        records: {
          path: ["normalized_result", "rows"],
          emitted: records.length,
          source: records.length,
        },
        context: {
          evidence_links: [parent.evidence_id],
          normalized_result: { parent_evidence_id: parent.evidence_id },
        },
      });
      const reconstructed = {
        ...final.context,
        normalized_result: {
          ...final.context.normalized_result,
          rows: records,
        },
      };
      // Authenticate the reconstructed Evidence, rather than checking only a few
      // convenient fields from a shortened view-shaped object.
      expect(parseEvidence(reconstructed)).toEqual(expected);
      expect(records.length).toBe(where === undefined ? 1 : 0);
    }

    // The documented disambiguating selection exports the same view rows.
    const selected = await cli.run({
      arguments: [
        "inspect-analysis-view",
        requestPath,
        "--format",
        "jsonl",
        "--filter-output",
        "normalized_result.rows",
      ],
    });
    expect(selected.exitCode, selected.stderr).toBe(0);
    expect(
      selected.stdout
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line))
        .at(-1),
    ).toMatchObject({
      type: "metadata",
      records: {
        path: ["normalized_result", "rows"],
        filter: "normalized_result.rows",
      },
    });
  },
);

cliTest(
  "refuses non-record SQLite selections as caller output errors while the analysis succeeds",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-json-lines-sqlite-");
    const path = join(root, "config.sqlite");
    const database = new DatabaseSync(path);
    try {
      database.exec(
        "CREATE TABLE configInts(name TEXT PRIMARY KEY, value INTEGER); INSERT INTO configInts VALUES ('a', 1), ('b', 2);",
      );
    } finally {
      database.close();
    }
    const table = ["--table", "configInts", "--row-limit", "3"];
    const json = await cli.run({
      arguments: ["inspect-sqlite-database", path, ...table, "--json"],
    });
    expect(json.exitCode, json.stderr).toBe(0);
    for (const [selection, option, observation] of [
      [
        [],
        "format",
        "The command result is not a JSON Lines record collection: normalized_result.rows is null.",
      ],
      [
        [...table, "--filter-output", "normalized_result.rows"],
        "filter-output",
        "The --filter-output selection normalized_result.rows is not a JSON Lines record collection: normalized_result.rows is an object.",
      ],
      [
        ["--filter-output", "normalized_result.schema.tables"],
        "filter-output",
        "The --filter-output selection normalized_result.schema.tables is not a JSON Lines record collection: it is an array outside a record collection boundary.",
      ],
    ] as const) {
      const result = await cli.run({
        arguments: [
          "inspect-sqlite-database",
          path,
          ...selection,
          "--format",
          "jsonl",
        ],
      });
      expect(result.exitCode).toBe(1);
      expect(result.stdout.trimEnd().split("\n")).toHaveLength(1);
      expect(result.json).toMatchObject({
        $rea: "jsonl/v1",
        type: "error",
        ok: false,
        result: {
          code: "invalid_request",
          category: "invalid_input",
          message: expect.stringContaining(observation),
          retryable: false,
          remediation: {
            action:
              "Use --format json for the complete document, or select one record collection with --filter-output.",
          },
          details: {
            operation: "inspect-sqlite-database",
            issues: [
              { path: [option], reason: "invalid_value", message: observation },
            ],
          },
        },
      });
      expect(result.stdout).not.toContain("rea doctor");
    }
  },
);
