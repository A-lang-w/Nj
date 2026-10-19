import { createHash } from "node:crypto";
import { open, stat, writeFile, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { ProcessCaptureReadFailure } from "../../../src/process/capture/ProcessCaptureRead.js";
import { observeSelectedExecutable } from "../../../src/process/capture/ProcessCaptureLifecycle.js";

it("cancels after real metadata IO without creating an already-aborted stream or leaking the file handle", async () => {
  const controller = new AbortController();
  const reason = new Error("cancel after executable path metadata");
  let opened: FileHandle | undefined;
  await expect(
    observeSelectedExecutable(process.execPath, controller.signal, {
      async open(path, flags) {
        opened = await open(path, flags);
        return opened;
      },
      async stat(path) {
        const metadata = await stat(path, { bigint: true });
        controller.abort(reason);
        return metadata;
      },
    }),
  ).rejects.toMatchObject({ reason: "cancelled", cause: reason });
  expect(opened?.fd).toBe(-1);
});

it.each([false, true])(
  "retains executable read and close ownership (cancel=%s)",
  async (cancel) => {
    const root = await createTestTempDirectory("rea-executable-read-cancel-");
    const path = join(root, "selected");
    const bytes = Buffer.alloc(256 * 1024, 42);
    await writeFile(path, bytes);
    const controller = new AbortController();
    const reason = new Error("cancel during executable bytes");
    let opened: FileHandle | undefined;
    let closes = 0;
    const failure: unknown = await observeSelectedExecutable(
      path,
      controller.signal,
      {
        async open(selected, flags) {
          const handle = await open(selected, flags);
          opened = handle;
          const close = handle.close.bind(handle);
          handle.close = async () => {
            closes += 1;
            await close();
          };
          // Both the previous stream and the owned read path perform real file IO.
          // Cancel at their first bytes, rather than before either read is started.
          const read = handle.read.bind(handle);
          vi.spyOn(handle, "read").mockImplementation(async (...args) => {
            const result = await Reflect.apply(read, handle, args);
            if (cancel) controller.abort(reason);
            return result;
          });
          const createReadStream = handle.createReadStream.bind(handle);
          vi.spyOn(handle, "createReadStream").mockImplementation((options) => {
            const stream = createReadStream(options);
            if (cancel) stream.once("data", () => controller.abort(reason));
            return stream;
          });
          return handle;
        },
        stat: (selected) => stat(selected, { bigint: true }),
      },
    ).catch((cause: unknown) => cause);
    expect(controller.signal.aborted).toBe(cancel);
    if (cancel) {
      expect(failure).toBeInstanceOf(ProcessCaptureReadFailure);
      if (!(failure instanceof ProcessCaptureReadFailure))
        throw new Error("Expected the cancelled executable read");
      expect(failure.cause).toBe(reason);
      expect(failure).toMatchObject({
        reason: "cancelled",
        userCategory: "cancelled",
        cleanupIncomplete: false,
        cleanupLeases: [],
      });
    } else {
      expect(failure).toMatchObject({
        sha256: createHash("sha256").update(bytes).digest("hex"),
        identity: expect.any(Object),
        reason: null,
      });
    }
    expect(closes).toBe(1);
    expect(opened?.fd).toBe(-1);
    await expect(opened?.stat()).rejects.toMatchObject({ code: "EBADF" });
  },
);
