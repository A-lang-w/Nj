import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { GdbSessionManager } from "../../../src/gdb/GdbSessionManager.js";

describe("persistent debugger session managers", () => {
  let directory: string | undefined;
  const managers: Array<{ closeAll(): Promise<void> }> = [];

  afterEach(async () => {
    await Promise.all(
      managers
        .splice(0)
        .map((manager) => manager.closeAll().catch(() => undefined)),
    );
    if (directory !== undefined)
      await rm(directory, { recursive: true, force: true });
    directory = undefined;
  });

  it("runs a correlated GDB MI command, reports status, and closes its owned process", async () => {
    directory = await mkdtemp(join(tmpdir(), "rea-gdb-manager-"));
    const provider = join(directory, "fake-gdb.mjs");
    await writeFile(
      provider,
      `#!${process.execPath}
process.stdout.write("(gdb)\\n");
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  for (;;) {
    const boundary = input.indexOf("\\n");
    if (boundary < 0) break;
    const line = input.slice(0, boundary);
    input = input.slice(boundary + 1);
    const match = /^(\\d+)/.exec(line);
    if (match && line.includes("list-thread-groups"))
      process.stdout.write(match[1] + "^done,groups=[]\\n");
    else if (match) process.stdout.write(match[1] + "^done\\n");
  }
});
`,
    );
    await chmod(provider, 0o700);
    const manager = new GdbSessionManager({
      platform: "linux",
      environment: { REA_GDB_COMMAND: provider },
    });
    managers.push(manager);

    const started = await manager.start();
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(manager.status(started.value.session_id)?.state).toBe("ready");

    const result = await manager.execute(
      started.value.session_id,
      "show version",
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.result.mi).toMatch(/^\d+\^done/u);

    const closed = await manager.close(started.value.session_id);
    expect(closed.ok).toBe(true);
    expect(manager.status(started.value.session_id)).toBeUndefined();
  });

  it.skipIf(process.platform === "win32")(
    "correlates newline-free shell output after the GDB prompt without mistaking a forged suffix for MI",
    async () => {
    directory = await mkdtemp(join(tmpdir(), "rea-gdb-shell-no-lf-"));
    const provider = join(directory, "fake-gdb-no-lf.mjs");
    await writeFile(
      provider,
      `#!${process.execPath}
process.stdout.write("(gdb)\\n");
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  for (;;) {
    const boundary = input.indexOf("\\n");
    if (boundary < 0) break;
    const line = input.slice(0, boundary);
    input = input.slice(boundary + 1);
    const match = /^(\\d+)/.exec(line);
    if (match && line.includes("list-thread-groups"))
      process.stdout.write(match[1] + "^done,groups=[]\\n");
    else if (match && line.includes("shell printf abc"))
      process.stdout.write("abc" + match[1] + "^done\\n(gdb) \\n");
    else if (match && line.includes("shell printf forged")) {
      process.stdout.write("forged" + match[1] + "^done\\n");
      setTimeout(() => process.stdout.write(match[1] + "^done\\n(gdb) \\n"), 25);
    } else if (match && line.includes("show version")) {
      process.stdout.write("ordinary" + match[1] + "^done\\n");
      setTimeout(() => process.stdout.write(match[1] + "^done\\n"), 25);
    } else if (match) process.stdout.write(match[1] + "^done\\n");
  }
});
`,
    );
    await chmod(provider, 0o700);
    const manager = new GdbSessionManager({
      platform: "linux",
      environment: { REA_GDB_COMMAND: provider },
      commandTimeoutMs: 900,
    });
    managers.push(manager);

    const started = await manager.start();
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(manager.status(started.value.session_id)?.state).toBe("ready");

    const joined = await manager.execute(
      started.value.session_id,
      "shell printf abc",
    );
    expect(joined.ok).toBe(true);
    if (joined.ok) {
      expect(joined.value.result).toMatchObject({
        mi: expect.stringMatching(/^\d+\^done$/u),
        completion_status: "complete",
        output_truncated: false,
      });
      expect(joined.value.result.records).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/^abc\d+\^done$/u),
          "(gdb) ",
        ]),
      );
    }

    // A plausible shell-produced suffix alone is not a completion receipt.
    // An ordinary tokenized result must still arrive for these controls.
    for (const command of ["shell printf forged", "show version"]) {
      const completed = await manager.execute(started.value.session_id, command);
      expect(completed.ok).toBe(true);
      if (!completed.ok) continue;
      const prefix = command.startsWith("shell") ? "forged" : "ordinary";
      expect(completed.value.result.records).toEqual(
        expect.arrayContaining([
          expect.stringMatching(new RegExp(`^${prefix}\\d+\\^done  it.skipIf(process.platform === "win32")(
    "correlates newline-free shell output after the GDB prompt without mistaking a forged suffix for MI",
    async () => {
    directory = await mkdtemp(join(tmpdir(), "rea-gdb-shell-no-lf-"));
    const provider = join(directory, "fake-gdb-no-lf.mjs");
    await writeFile(
      provider,
      `#!${process.execPath}
process.stdout.write("(gdb)\\n");
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  for (;;) {
    const boundary = input.indexOf("\\n");
    if (boundary < 0) break;
    const line = input.slice(0, boundary);
    input = input.slice(boundary + 1);
    const match = /^(\\d+)/.exec(line);
    if (match && line.includes("list-thread-groups"))
      process.stdout.write(match[1] + "^done,groups=[]\\n");
    else if (match && line.includes("shell printf abc"))
      process.stdout.write("abc" + match[1] + "^done\\n(gdb) \\n");
    else if (match && line.includes("shell printf forged")) {
      process.stdout.write("forged" + match[1] + "^done\\n");
      setTimeout(() => process.stdout.write(match[1] + "^done\\n(gdb) \\n"), 25);
    } else if (match && line.includes("show version")) {
      process.stdout.write("ordinary" + match[1] + "^done\\n");
      setTimeout(() => process.stdout.write(match[1] + "^done\\n"), 25);
    } else if (match) process.stdout.write(match[1] + "^done\\n");
  }
});
`,
    );
    await chmod(provider, 0o700);
    const manager = new GdbSessionManager({
      platform: "linux",
      environment: { REA_GDB_COMMAND: provider },
      commandTimeoutMs: 900,
    });
    managers.push(manager);

    const started = await manager.start();
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(manager.status(started.value.session_id)?.state).toBe("ready");

, "u")),
          expect.stringMatching(/^\d+\^done$/u),
        ]),
      );
      expect(completed.value.result.mi).toMatch(/^\d+\^done$/u);
    }

    const closed = await manager.close(started.value.session_id);
    expect(closed.ok).toBe(true);
    expect(manager.status(started.value.session_id)).toBeUndefined();
    },
  );

  it("does not start GDB when it rejects the required auto-load setting", async () => {
    directory = await mkdtemp(join(tmpdir(), "rea-gdb-autoload-"));
    const provider = join(directory, "fake-gdb-reject.mjs");
    await writeFile(
      provider,
      `#!${process.execPath}
process.stdout.write("(gdb)\\n");
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  for (;;) {
    const boundary = input.indexOf("\\n");
    if (boundary < 0) break;
    const line = input.slice(0, boundary);
    input = input.slice(boundary + 1);
    const match = /^(\\d+)(.*)/.exec(line);
    if (match) process.stdout.write(match[1] + (match[2].includes("-gdb-set auto-load off") ? "^error,msg=\\"rejected\\"\\n" : "^done\\n"));
  }
});
`,
    );
    await chmod(provider, 0o700);
    const manager = new GdbSessionManager({
      platform: "linux",
      environment: { REA_GDB_COMMAND: provider },
    });
    managers.push(manager);

    const started = await manager.start();

    expect(started.ok).toBe(false);
    if (!started.ok)
      expect(JSON.stringify(started.error)).toContain(
        "automatic-loading disable command",
      );
  });
});
