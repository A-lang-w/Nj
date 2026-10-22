import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { recording } from "./fixtures.ts";

const cli = fileURLToPath(new URL("./cli.js", import.meta.url));

test("CLI returns attributable JSON and leaves the recording unchanged", async (t) => {
  const folder = mkdtempSync(join(tmpdir(), "mcap-prototype-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const path = join(folder, "two sensors.mcap");
  const bytes = await recording();
  writeFileSync(path, bytes);
  const output: unknown = JSON.parse(
    execFileSync(process.execPath, [cli, path, "--schema", "1"], {
      encoding: "utf8",
    }),
  );
  assert.ok(output !== null && typeof output === "object" && "ok" in output);
  assert.equal(output.ok, true);
  assert.ok("read_ranges" in output && Array.isArray(output.read_ranges));
  assert.equal(output.read_ranges.length, 4);
  const ranges: readonly unknown[] = output.read_ranges;
  for (const range of ranges) {
    assert.ok(typeof range === "object" && range !== null);
    assert.ok("offset" in range && "byte_length" in range && "sha256" in range);
    assert.ok(
      typeof range.offset === "string" && typeof range.byte_length === "string",
    );
    const offset = Number(range.offset);
    const data = bytes.subarray(offset, offset + Number(range.byte_length));
    assert.equal(range.sha256, createHash("sha256").update(data).digest("hex"));
  }
  assert.deepEqual(readFileSync(path), bytes);
});

test("CLI rejects missing inputs, directories, malformed files and invalid options", async (t) => {
  const folder = mkdtempSync(join(tmpdir(), "mcap-prototype-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const bad = join(folder, "bad.mcap");
  writeFileSync(bad, "not an mcap recording");
  for (const args of [
    [],
    [join(folder, "missing.mcap")],
    [folder],
    [bad],
    [bad, "--schema", "0"],
    [bad, "--schema", "1.5"],
    [bad, "--schema", "65536"],
    [bad, "--unknown"],
  ]) {
    const result = spawnSync(process.execPath, [cli, ...args], {
      encoding: "utf8",
    });
    assert.equal(result.status, 1, result.stderr);
    const output: unknown = JSON.parse(result.stdout);
    assert.ok(output !== null && typeof output === "object" && "ok" in output);
    assert.equal(output.ok, false);
    assert.equal(result.stderr, "");
  }
});
