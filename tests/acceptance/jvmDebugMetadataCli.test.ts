import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";

import { toolContract } from "../../src/contracts/toolContracts.js";
import { jvmDebugClass } from "../fixtures/jvmDebugClass.js";
import { connectLocalToolsMcp } from "../fixtures/localToolsMcp.js";
import { parseMcpToolError } from "../fixtures/mcpToolError.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest, type TestCli } from "../support/cli/cliFixture.js";

const TOOL = "inspect_jvm_debug_metadata";

/** Run one selection over CLI and MCP and require the same outcome from both. */
const inspectBoth = async (
  cli: TestCli,
  call: Awaited<ReturnType<typeof connectLocalToolsMcp>>["call"],
  input: { readonly path: string; readonly entry?: string },
): Promise<
  | { readonly ok: true; readonly evidence: unknown }
  | { readonly ok: false; readonly error: unknown }
> => {
  const viaCli = await cli.run({
    arguments: [
      "inspect-jvm-debug-metadata",
      input.path,
      ...(input.entry === undefined ? [] : ["--entry", input.entry]),
      "--json",
    ],
  });
  const viaMcp = await call(TOOL, input);
  if (viaCli.exitCode !== 0) {
    expect(parseMcpToolError(viaMcp).error).toMatchObject(
      viaCli.json as object,
    );
    return { ok: false, error: viaCli.json };
  }
  const evidence = toolContract(TOOL).outputSchema.parse(viaCli.json);
  expect(viaMcp.isError, JSON.stringify(viaMcp)).not.toBe(true);
  expect(viaMcp.structuredContent).toEqual(evidence);
  return { ok: true, evidence };
};

cliTest(
  "refuses a class file with bytes after its structure over CLI and MCP",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-jvm-trailing-");
    const path = join(root, "Example.class");
    await writeFile(path, jvmDebugClass({ trailingBytes: 3 }));
    const { client, call } = await connectLocalToolsMcp();
    const outcome = await inspectBoth(cli, call, { path });
    expect(outcome).toMatchObject({
      ok: false,
      error: {
        code: "invalid_request",
        details: {
          issues: [
            {
              path: ["path"],
              reason: "invalid_format",
              message: expect.stringContaining("3 extra bytes") as string,
            },
          ],
        },
      },
    });
    await client.ping();
  },
  30000,
);
