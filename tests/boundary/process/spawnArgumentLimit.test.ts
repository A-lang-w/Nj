import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { processTest } from "../../support/process/processFixture.js";
import {
  assertSpawnArgumentsWithinLimit,
  LINUX_4K_SINGLE_ARGUMENT_BYTES,
} from "../../support/process/spawnArgumentLimit.js";

const minimalSpawnEnvironment = (): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH ?? "",
  ...(process.platform === "win32"
    ? {
        SystemRoot: process.env.SystemRoot,
        TEMP: tmpdir(),
        TMP: tmpdir(),
      }
    : {}),
});

const linuxPageSize = (): number => {
  const raw = execFileSync("getconf", ["PAGE_SIZE"], {
    encoding: "utf8",
  }).trim();
  const pageSize = Number(raw);
  if (!Number.isSafeInteger(pageSize) || pageSize < 1)
    throw new Error(`unexpected PAGE_SIZE ${raw}`);
  return pageSize;
};

processTest(
  "spawns a file path when the payload exceeds the single-argument budget",
  async ({ processes }) => {
    const root = await createTestTempDirectory("rea-spawn-argument-");
    const payload = "x".repeat(LINUX_4K_SINGLE_ARGUMENT_BYTES + 1);
    const file = join(root, "payload.txt");
    await writeFile(file, payload);
    expect(() => assertSpawnArgumentsWithinLimit([file])).not.toThrow();
    expect(() => assertSpawnArgumentsWithinLimit([payload])).toThrow(/E2BIG/u);
    const result = await processes.run(
      process.execPath,
      ["-e", "process.exit(0)", file],
      { env: minimalSpawnEnvironment(), timeoutMs: 15_000 },
    );
    expect(result.exitCode).toBe(0);
  },
);

it("counts UTF-8 bytes when applying the single-argument budget", () => {
  const argument = "é".repeat(
    Math.ceil((LINUX_4K_SINGLE_ARGUMENT_BYTES + 1) / 2),
  );
  expect(argument.length).toBeLessThanOrEqual(LINUX_4K_SINGLE_ARGUMENT_BYTES);
  expect(Buffer.byteLength(argument)).toBeGreaterThan(
    LINUX_4K_SINGLE_ARGUMENT_BYTES,
  );
  expect(() => assertSpawnArgumentsWithinLimit([argument])).toThrow(/E2BIG/u);
  expect(() =>
    assertSpawnArgumentsWithinLimit([
      "x".repeat(LINUX_4K_SINGLE_ARGUMENT_BYTES),
    ]),
  ).not.toThrow();
});

processTest.skipIf(process.platform !== "linux")(
  "matches the kernel single-argument ceiling through the test process registry",
  async ({ processes }) => {
    const pageSize = linuxPageSize();
    const budget = 32 * pageSize - 1;
    expect(LINUX_4K_SINGLE_ARGUMENT_BYTES).toBeLessThanOrEqual(budget);
    if (pageSize === 4096) expect(LINUX_4K_SINGLE_ARGUMENT_BYTES).toBe(budget);

    const accepted = await processes.run(
      process.execPath,
      ["-e", "process.exit(0)", "x".repeat(budget)],
      { env: minimalSpawnEnvironment(), timeoutMs: 15_000 },
    );
    expect(accepted.exitCode).toBe(0);

    let caught: unknown;
    try {
      await processes.run(
        process.execPath,
        ["-e", "process.exit(0)", "x".repeat(budget + 1)],
        { env: minimalSpawnEnvironment(), timeoutMs: 15_000 },
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: "E2BIG" });
  },
);
