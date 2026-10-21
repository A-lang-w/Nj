import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect } from "vitest";
import { z } from "zod";

import { keyedArchiveResultSchema } from "../../../src/domain/apple/keyedArchive.js";
import {
  expectKeyedArchiveDatePrecision,
  reportedDateArchiveBytes,
  reportedDateArchives,
} from "../../fixtures/keyedArchiveDates.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { mcpTest } from "../../support/mcp/mcpFixture.js";
import { openProductionTarget } from "../../support/mcp/productionSession.js";

mcpTest.for(reportedDateArchives)(
  "MCP reports the source instant of the $name date archive",
  async (archive, { mcp, onTestFinished }) => {
    const root = await createTestTempDirectory("rea-keyed-archive-date-");
    const path = join(root, "archive.plist");
    await writeFile(path, reportedDateArchiveBytes(archive));
    const client = await openProductionTarget(mcp, onTestFinished, path);
    const result = await client.callTool({
      name: "inspect_keyed_archive",
      arguments: {},
    });
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    expectKeyedArchiveDatePrecision(
      z
        .object({ normalized_result: keyedArchiveResultSchema })
        .parse(result.structuredContent).normalized_result,
      archive,
    );
  },
);
