import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { EvmInterfaceService } from "../../../src/application/evm/EvmInterfaceService.js";
import { EvmoleInterfaceProvider } from "../../../src/evm/EvmoleInterfaceProvider.js";
import { AnalysisCancelledError } from "../../../src/domain/analysisErrorCore.js";

const seam = vi.hoisted(() => ({
  mode: "admission" as "admission" | "close" | "pre-aborted",
  abort: () => {},
  path: "",
  closed: false,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      if (args[0] === "/proc/self/limits") {
        if (seam.mode === "admission") seam.abort();
        return "Max address space unlimited unlimited bytes\nMax cpu time unlimited unlimited seconds\nMax file size unlimited unlimited bytes\n";
      }
      return actual.readFile(...args);
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      const file = await actual.open(...args);
      if (args[0] === seam.path) {
        const close = file.close.bind(file);
        file.close = async () => {
          await close();
          seam.closed = true;
          if (seam.mode === "close") seam.abort();
        };
      }
      return file;
    },
  };
});

it.each(["pre-aborted", "admission", "close"] as const)(
  "keeps the caller's abort reason as the typed cause when cancellation lands at %s",
  async (mode) => {
    const root = await mkdtemp(join(tmpdir(), "rea-evm-cancel-"));
    const path = join(root, "carrier.hex");
    await writeFile(path, "0x60006000f3\n");
    const controller = new AbortController();
    const reason = { requested: "caller stop" };
    seam.mode = mode;
    seam.path = path;
    seam.closed = false;
    seam.abort = () => controller.abort(reason);
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    const arch = Object.getOwnPropertyDescriptor(process, "arch")!;
    Object.defineProperty(process, "platform", { ...platform, value: "linux" });
    Object.defineProperty(process, "arch", { ...arch, value: "x64" });
    const createRuntime = vi.fn(async () => {
      throw new Error("Worker must not start");
    });
    const provider = new EvmoleInterfaceProvider(
      { REA_EVM_PRLIMIT_COMMAND: process.execPath },
      undefined,
      createRuntime,
    );
    try {
      if (mode === "pre-aborted") controller.abort(reason);
      const result = await new EvmInterfaceService(provider).inspect(
        { path, encoding: "hex" },
        { signal: controller.signal },
      );
      if (result.ok) throw new Error("Expected cancellation");
      expect(result.error).toBeInstanceOf(AnalysisCancelledError);
      expect(createRuntime).not.toHaveBeenCalled();
      expect(result.error.cleanupIncomplete).toBe(false);
      expect(result.error.cause).toBe(reason);
      if (mode === "close") expect(seam.closed).toBe(true);
    } finally {
      await provider.close();
      Object.defineProperty(process, "platform", platform);
      Object.defineProperty(process, "arch", arch);
      await rm(root, { recursive: true, force: true });
    }
  },
);
