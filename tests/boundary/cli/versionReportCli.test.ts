import { readFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";

import { expect } from "vitest";
import { z } from "zod";

import { versionReportSchema } from "../../../src/domain/versionReport.js";
import { SUPPORTED_NODE_VERSION_RANGE } from "../../../src/domain/runtimeVersion.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

const packageSchema = z.object({ name: z.string(), version: z.string() });

cliTest(
  "reports version and runtime as a document only when a format is selected",
  async ({ cli }) => {
    const { name, version } = packageSchema.parse(
      JSON.parse(await readFile("package.json", "utf8")),
    );
    const cwd = await createTestTempDirectory("rea-version-report-");

    const json = await cli.run({ arguments: ["--version", "--json"], cwd });
    expect(json.exitCode, json.stderr).toBe(0);
    // Piped JSON is one compact document.
    expect(json.stdout.trimEnd().split("\n")).toHaveLength(1);
    const report = versionReportSchema.parse(JSON.parse(json.stdout));
    expect(report).toEqual({
      name,
      version,
      runtime: { id: "node", version: process.versions.node },
      platform: process.platform,
      architecture: process.arch,
      supported_runtime: {
        range: SUPPORTED_NODE_VERSION_RANGE,
        satisfied: true,
      },
    });
    for (const identifying of [homedir(), cwd, userInfo().username])
      expect(json.stdout).not.toContain(identifying);

    const yaml = await cli.run({
      arguments: ["--version", "--format=yaml"],
      cwd,
    });
    expect(yaml.exitCode, yaml.stderr).toBe(0);
    expect(yaml.stdout).toContain(`version: ${version}`);
    expect(yaml.stdout).toContain(`architecture: ${process.arch}`);

    // Plain --version keeps the bare version string.
    const plain = await cli.run({ arguments: ["--version"], cwd });
    expect(plain.exitCode, plain.stderr).toBe(0);
    expect(plain.stdout).toBe(`${version}\n`);

    // Help keeps precedence over --version.
    const help = await cli.run({
      arguments: ["--version", "--json", "--help"],
      cwd,
    });
    expect(help.exitCode, help.stderr).toBe(0);
    expect(help.stdout).toContain("Usage: rea");
  },
);
