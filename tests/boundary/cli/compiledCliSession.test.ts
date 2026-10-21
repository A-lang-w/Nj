import { EventEmitter, PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, test } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { startCompiledCliSession } from "../../support/cli/compiledCliSession.js";

interface FakeCliProcess extends EventEmitter {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  pid: number;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals): boolean;
}

const fakeProcess = (pid: number): FakeCliProcess => {
  const child = new EventEmitter() as FakeCliProcess;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = pid;
  child.exitCode = null;
  child.signalCode = null;
  child.kill = (signal: NodeJS.Signals = "SIGTERM") => {
    if (child.exitCode !== null || child.signalCode !== null) return true;
    child.signalCode = signal;
    child.emit("exit", null, signal);
    child.emit("close", null, signal);
    return true;
  };
  return child;
};

const asCliProcess = (child: FakeCliProcess): ChildProcessWithoutNullStreams =>
  child as unknown as ChildProcessWithoutNullStreams;

const ready = (child: FakeCliProcess): void => {
  child.stdout.write(`${JSON.stringify({ ready: true })}\n`);
};

const exitWhenStdinCloses = (child: FakeCliProcess): void => {
  child.stdin.on("finish", () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.exitCode = 0;
    child.emit("exit", 0, null);
    child.emit("close", 0, null);
  });
};

const replyWhenAsked = (
  child: FakeCliProcess,
  stdout: string,
  exitCode = 0,
): void => {
  let buffer = "";
  child.stdin.setEncoding("utf8");
  child.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.length > 0) {
        const request = JSON.parse(line) as { id: number };
        child.stdout.write(
          `${JSON.stringify({ id: request.id, exitCode, stdout })}\n`,
        );
      }
      newline = buffer.indexOf("\n");
    }
  });
};

test("rejects a compiled CLI command that never replies and serves the next one", async () => {
  const children: FakeCliProcess[] = [];
  const session = startCompiledCliSession({
    requestTimeoutMs: 30,
    spawnWorker: () => {
      const child = fakeProcess(70 + children.length);
      children.push(child);
      exitWhenStdinCloses(child);
      ready(child);
      if (children.length > 1)
        replyWhenAsked(child, JSON.stringify({ ok: true }));
      return asCliProcess(child);
    },
  });

  await expect(session.run(["stuck"])).rejects.toThrow(/did not respond/);
  expect(children[0]?.signalCode).toBe("SIGKILL");
  await expect(session.run(["next"])).resolves.toEqual({ ok: true });
  expect(children).toHaveLength(2);
  await session.close();
});

test("reports a compiled CLI session that needed a signal after stdin closed", async () => {
  let child: FakeCliProcess | undefined;
  const signals: NodeJS.Signals[] = [];
  const session = startCompiledCliSession({
    stopTimeoutMs: 20,
    spawnWorker: () => {
      child = fakeProcess(81);
      child.kill = (signal: NodeJS.Signals = "SIGTERM") => {
        signals.push(signal);
        if (signal !== "SIGKILL") return true;
        if (child?.exitCode !== null || child?.signalCode !== null) return true;
        child.signalCode = signal;
        child.emit("exit", null, signal);
        child.emit("close", null, signal);
        return true;
      };
      ready(child);
      replyWhenAsked(child, JSON.stringify({ ok: true }));
      return asCliProcess(child);
    },
  });

  await expect(session.run(["once"])).resolves.toEqual({ ok: true });
  await expect(session.close()).rejects.toThrow(
    "Compiled CLI session did not exit after stdin closed",
  );
  expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  expect(child?.signalCode).toBe("SIGKILL");
});

test("closes a compiled CLI session that exits after stdin closes", async () => {
  const session = startCompiledCliSession({
    spawnWorker: () => {
      const child = fakeProcess(82);
      exitWhenStdinCloses(child);
      ready(child);
      replyWhenAsked(child, JSON.stringify({ ok: true }));
      return asCliProcess(child);
    },
  });

  await expect(session.run(["once"])).resolves.toEqual({ ok: true });
  await session.close();
});

test("keeps a compiled CLI failure status and serves the next command", async () => {
  const session = startCompiledCliSession();
  const root = await createTestTempDirectory("rea-warm-cli-status-");
  await writeFile(
    join(root, "app.mjs"),
    "export function current() { return 1; }\n",
  );

  await expect(
    session.run(["compare-javascript-export-shapes", "{", "--json"]),
  ).rejects.toThrow(/status 1:.*invalid_request/);
  await expect(
    session.run(["analyze-javascript-application", root, "--json"]),
  ).resolves.toMatchObject({
    normalized_result: expect.any(Object),
  });
  await session.close();
});
