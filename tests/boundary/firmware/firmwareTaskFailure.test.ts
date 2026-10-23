import { createHash } from "node:crypto";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { FirmwareFileAccess } from "../../../src/firmware/FirmwareFiles.js";
import { normalizeUnblobReport } from "../../../src/firmware/FirmwareReports.js";
import { publishFirmwareExtraction } from "../../../src/firmware/FirmwarePublication.js";
import { startFirmwareDeadline } from "../../../src/firmware/FirmwareDeadline.js";
import type { JsonValue } from "../../../src/domain/jsonValue.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const taskError = {
  __typename__: "UnknownError",
  severity: "ERROR",
  exception: "Self-authored task exception after metadata collection",
};

it.each<{
  name: string;
  reports: JsonValue[];
  gap: "extractor-failure" | "missing-extractor-dependency" | null;
}>([
  { name: "clean task", reports: [], gap: null },
  { name: "task exception", reports: [taskError], gap: "extractor-failure" },
  {
    name: "repeated task exceptions",
    reports: [taskError, { ...taskError, exception: "Another task exception" }],
    gap: "extractor-failure",
  },
  {
    name: "dependency failure",
    reports: [
      {
        __typename__: "ExtractorDependencyNotFoundReport",
        severity: "ERROR",
        dependencies: ["fixture-tool"],
      },
    ],
    gap: "missing-extractor-dependency",
  },
  {
    name: "warning diagnostic",
    reports: [{ ...taskError, severity: "WARNING" }],
    gap: null,
  },
  {
    name: "malformed task exception",
    reports: [{ ...taskError, exception: null }],
    gap: null,
  },
  {
    name: "unrecognized report",
    reports: [{ ...taskError, __typename__: "FutureReport" }],
    gap: null,
  },
])(
  "publishes recovery metadata for $name without inventing byte ownership",
  async ({ reports, gap }) => {
    const root = await createTestTempDirectory("rea-firmware-task-failure-");
    const inputPath = join(root, "input.bin");
    const outputRoot = join(root, "extracted");
    const outputDirectory = join(root, "published");
    const bytes = Buffer.alloc(20);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    await writeFile(inputPath, bytes);
    await mkdir(outputRoot);
    const files = new FirmwareFileAccess();
    onTestFinished(() => files.close());
    const normalized = normalizeUnblobReport(
      [
        {
          task: {
            path: inputPath,
            depth: 0,
            blob_id: "",
            is_multi_file: false,
          },
          reports: [
            {
              __typename__: "StatReport",
              path: inputPath,
              size: bytes.length,
              is_file: true,
              is_dir: false,
              is_link: false,
              link_target: null,
            },
            { __typename__: "HashReport", sha256 },
            ...reports,
          ],
          subtasks: [],
        },
      ],
      {
        inputPath,
        outputRoot,
        sha256,
        length: bytes.length,
        offset: 0,
        maxDepth: 3,
      },
    );
    const result = await publishFirmwareExtraction({
      files,
      workspacePath: root,
      deadline: startFirmwareDeadline("publication", 120_000),
      analysisTimeoutMs: 120_000,
      outputDirectory,
      entries: [],
      normalized,
      selection: { offset: 0, length: bytes.length, sha256 },
      maxDepth: 3,
      engine: {
        name: "unblob",
        version: "26.6.4",
        executable_path: join(root, "synthetic-unblob"),
        executable_sha256: sha256,
        source_revision: null,
        worker_count: 1,
      },
      signal: new AbortController().signal,
      retainCleanup: (_tree, lease) => {
        onTestFinished(() => lease.release());
      },
    });
    expect(result.coverage).toBe(reports.length === 0 ? "complete" : "partial");
    expect(result.diagnostics).toEqual(
      reports.map((report) => ({ input_path: "$input", report })),
    );
    expect(result.files).toEqual([]);
    expect(result.published_bytes).toBe(0);
    expect(await readdir(outputDirectory)).toEqual([]);
    if (gap === null) {
      expect(result.extraction_gaps).toEqual([]);
      expect(result.extraction_continuations).toEqual([]);
    } else {
      expect(result.extraction_gaps).toHaveLength(1);
      expect(result.extraction_gaps[0]).toMatchObject({
        kind: gap,
        input_path: "$input",
        provider_id: null,
        handler: null,
        range: null,
        root_file_range: null,
        dependencies:
          gap === "missing-extractor-dependency" ? ["fixture-tool"] : [],
      });
      expect(result.extraction_continuations).toEqual([
        {
          id: result.extraction_gaps[0]?.continuation_id,
          instruction: expect.stringContaining(
            gap === "extractor-failure" ? "diagnostics" : "named dependency",
          ),
        },
      ]);
    }
  },
);
