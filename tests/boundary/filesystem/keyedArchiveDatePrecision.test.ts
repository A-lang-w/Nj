import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect } from "vitest";

import { parseEvidence } from "../../../src/domain/evidence.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import {
  expectKeyedArchiveDatePrecision,
  reportedDateArchiveBytes,
  reportedDateArchives,
} from "../../fixtures/keyedArchiveDates.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest.for(reportedDateArchives)(
  "built CLI reports the source instant of the $name date archive",
  async (archive, { cli }) => {
    const root = await createTestTempDirectory("rea-keyed-archive-date-");
    const path = join(root, "archive.plist");
    await writeFile(path, reportedDateArchiveBytes(archive));
    const output = await cli.run({
      arguments: ["inspect-keyed-archive", path, "--json"],
      environment: { REA_LOG_LEVEL: "silent", REA_ANALYSIS_PROVIDER: "auto" },
    });
    expect(output.exitCode).toBe(0);
    expectKeyedArchiveDatePrecision(
      parseEvidence(output.json).normalized_result,
      archive,
    );
  },
);
