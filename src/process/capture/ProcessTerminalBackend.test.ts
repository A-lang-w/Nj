import { expect, it } from "vitest";

import {
  nativePtyUsable,
  processTerminalBackend,
  spawnProcessTerminal,
} from "./ProcessTerminalBackend.js";

/** Run one shell script through the pipe backend and collect what it produced. */
const run = async (
  script: string,
  options: { readonly write?: string } = {},
): Promise<{
  readonly output: string;
  readonly exit: { readonly exitCode: number; readonly signal?: number };
  readonly backend: string;
}> => {
  const { terminal, backend } = await spawnProcessTerminal(
    "/bin/sh",
    ["-c", script],
    {
      cwd: process.cwd(),
      env: process.env,
      cols: 80,
      rows: 24,
      name: "xterm-256color",
    },
    "pipe",
  );
  let output = "";
  terminal.onData((data) => {
    output += data;
  });
  const exited = new Promise<{
    readonly exitCode: number;
    readonly signal?: number;
  }>((resolve) => terminal.onExit(resolve));
  // A resize with no PTY is a recorded no-op, not an error.
  terminal.resize(120, 40);
  if (options.write !== undefined) terminal.write(options.write);
  const exit = await exited;
  return { output, exit, backend };
};

it("runs the command under pipes and reports its output and exit code", async () => {
  const { output, exit, backend } = await run(
    "printf hello; printf oops >&2; exit 3",
  );
  expect(backend).toBe("pipe");
  expect(output).toContain("hello");
  expect(output).toContain("oops");
  expect(exit.exitCode).toBe(3);
});

it("carries scripted input to the command's standard input", async () => {
  const { output, exit } = await run("read line; printf 'got:%s' \"$line\"", {
    write: "typed\n",
  });
  expect(output).toContain("got:typed");
  expect(exit.exitCode).toBe(0);
});

it.skipIf(process.platform !== "linux")(
  "chooses the pipe backend on a runtime with no glibc",
  () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, "report");
    try {
      // A musl runtime reports no glibc, which is the only signal available
      // before the native module would be loaded and fault.
      Object.defineProperty(process, "report", {
        value: { getReport: () => ({ header: {} }) },
        configurable: true,
      });
      expect(nativePtyUsable()).toBe(false);
      expect(processTerminalBackend()).toBe("pipe");
    } finally {
      if (descriptor !== undefined)
        Object.defineProperty(process, "report", descriptor);
    }
  },
);

it("reports a signal when the command is killed", async () => {
  const { terminal } = await spawnProcessTerminal(
    "/bin/sh",
    ["-c", "sleep 30"],
    {
      cwd: process.cwd(),
      env: process.env,
      cols: 80,
      rows: 24,
      name: "xterm-256color",
    },
    "pipe",
  );
  const exited = new Promise<{
    readonly exitCode: number;
    readonly signal?: number;
  }>((resolve) => terminal.onExit(resolve));
  terminal.kill("SIGTERM");
  const exit = await exited;
  expect(exit.signal).toBe(15);
});
