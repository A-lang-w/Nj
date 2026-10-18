import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import type { execFileOutput } from "../process/ExecFileOutput.js";
import { inspectLinuxHopperPythonRuntime } from "./LinuxHopperPython.js";

const response = (value: unknown) => {
  const stdout = JSON.stringify(value);
  return {
    stdout,
    stderr: "",
    stdoutBytes: Buffer.byteLength(stdout),
    stderrBytes: 0,
  };
};
const available = {
  version: [3, 14],
  library: { status: "loadable", path: "/usr/lib/libpython3.14.so.1.0" },
};

describe("distribution Python runtime inspection", () => {
  it("preserves version and library identity without assuming Python 3.12", async () => {
    const execute = vi
      .fn<typeof execFileOutput>()
      .mockResolvedValue(response(available));
    const environment = {
      PYTHONHOME: "/caller/python",
      PYTHONPATH: "/caller/modules",
    };
    const result = await inspectLinuxHopperPythonRuntime(
      environment,
      undefined,
      execute,
    );
    expect(result).toEqual({
      ok: true,
      value: { ...available, interpreter: "/usr/bin/python3" },
    });
    expect(execute).toHaveBeenCalledWith(
      "/usr/bin/python3",
      expect.arrayContaining(["-I", "-S", "-B"]),
      expect.objectContaining({
        env: environment,
        timeout: 10_000,
        maxBuffer: 64 * 1024,
      }),
    );
  });

  it.each([
    { version: [2, 7], library: available.library },
    { version: [3, "14"], library: available.library },
    {
      version: [3, 14],
      library: { status: "loadable", path: "relative/libpython.so" },
    },
    {
      version: [3, 14],
      library: { status: "loadable", path: "C:\\not-a-linux-path\\python.dll" },
    },
    {
      version: [3, 14],
      library: { status: "loadable", path: "/usr/lib/python\0.so" },
    },
    {
      version: [3, 14],
      library: { status: "unavailable", path: "/lib/python.so" },
    },
    null,
  ])(
    "refuses malformed facts without reporting library absence: %j",
    async (value) => {
      const execute = vi
        .fn<typeof execFileOutput>()
        .mockResolvedValue(response(value));
      const result = await inspectLinuxHopperPythonRuntime(
        {},
        undefined,
        execute,
      );
      expect(result).toMatchObject({
        ok: false,
        error: { reason: "invalid_response" },
      });
    },
  );

  it("retains unknown configuration and observes a later repaired library afresh", async () => {
    const unknown = {
      version: [3, 14],
      library: { status: "unknown", reason: "No INSTSONAME" },
    };
    const execute = vi
      .fn<typeof execFileOutput>()
      .mockResolvedValueOnce(response(unknown))
      .mockResolvedValueOnce(response(available));
    expect(
      await inspectLinuxHopperPythonRuntime({}, undefined, execute),
    ).toMatchObject({ ok: true, value: unknown });
    expect(
      await inspectLinuxHopperPythonRuntime({}, undefined, execute),
    ).toMatchObject({ ok: true, value: available });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("distinguishes execution and JSON failures from an unavailable library", async () => {
    const execute = vi
      .fn<typeof execFileOutput>()
      .mockRejectedValueOnce(new Error("fixture execution failure"))
      .mockResolvedValueOnce({
        stdout: "{",
        stderr: "",
        stdoutBytes: 1,
        stderrBytes: 0,
      });
    expect(
      await inspectLinuxHopperPythonRuntime({}, undefined, execute),
    ).toMatchObject({ ok: false, error: { reason: "query_failed" } });
    expect(
      await inspectLinuxHopperPythonRuntime({}, undefined, execute),
    ).toMatchObject({ ok: false, error: { reason: "invalid_response" } });
  });
});

describe("distribution Python isolation and cancellation", () => {
  it("preserves cancellation and starts no interpreter for an already cancelled query", async () => {
    const controller = new AbortController();
    const reason = new Error("caller cancellation");
    controller.abort(reason);
    const execute = vi.fn<typeof execFileOutput>();
    const result = await inspectLinuxHopperPythonRuntime(
      {},
      controller.signal,
      execute,
    );
    expect(result).toMatchObject({
      ok: false,
      error: { reason: "cancelled", cause: reason },
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("observes cancellation that arrives during interpreter execution", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled during query");
    const execute = vi
      .fn<typeof execFileOutput>()
      .mockImplementation(async () => {
        controller.abort(reason);
        return response(available);
      });
    const result = await inspectLinuxHopperPythonRuntime(
      {},
      controller.signal,
      execute,
    );
    expect(result).toMatchObject({
      ok: false,
      error: { reason: "cancelled", cause: reason },
    });
  });

  it.skipIf(process.platform !== "linux" || !existsSync("/usr/bin/python3"))(
    "runs the real producer without loading caller Python modules or PYTHONHOME",
    async () => {
      const directory = await createTestTempDirectory("rea-system-python-");
      for (const name of ["ctypes.py", "sysconfig.py", "sitecustomize.py"])
        await writeFile(
          join(directory, name),
          "raise RuntimeError('caller module was loaded')\n",
        );
      const result = await inspectLinuxHopperPythonRuntime({
        ...process.env,
        PYTHONPATH: directory,
        PYTHONHOME: join(directory, "missing-python-home"),
      });
      expect(result).toMatchObject({
        ok: true,
        value: {
          interpreter: "/usr/bin/python3",
          version: [3, expect.any(Number)],
        },
      });
    },
  );
});
