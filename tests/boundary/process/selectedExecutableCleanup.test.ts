import { createHash } from "node:crypto";
import { mkdtemp, open, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

const injected = vi.hoisted(() => ({
  path: "",
  closeFailure: undefined as Error | undefined,
  primaryFailure: undefined as Error | undefined,
  abortOnClose: undefined as (() => void) | undefined,
  abortOnRead: undefined as (() => void) | undefined,
  readFailure: undefined as Error | undefined,
  opened: [] as string[],
  closed: [] as string[],
  handles: [] as {
    isOpen: () => boolean;
    close: () => Promise<void>;
    restore: () => void;
  }[],
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    open: async (...args: Parameters<typeof original.open>) => {
      const handle = await original.open(...args);
      const path = String(args[0]);
      injected.opened.push(path);
      if (path !== injected.path) return handle;
      const nativeClose = handle.close.bind(handle);
      if (injected.readFailure !== undefined) {
        const failure = injected.readFailure;
        vi.spyOn(handle, "read").mockImplementation(async () => {
          injected.abortOnRead?.();
          throw failure;
        });
      }
      injected.handles.push({
        isOpen: () => handle.fd >= 0,
        close: nativeClose,
        restore: () => {
          handle.close = nativeClose;
        },
      });
      handle.close = async () => {
        injected.closed.push(path);
        injected.abortOnClose?.();
        if (injected.closeFailure !== undefined) throw injected.closeFailure;
        await nativeClose();
      };
      return handle;
    },
  };
});

import { ProcessCaptureResourceScope } from "../../../src/process/capture/ProcessCaptureLifecycle.js";
import { RegularFileOperationCancelled } from "../../../src/filesystem/RegularFile.js";
import { ProcessCaptureReadFailure } from "../../../src/process/capture/ProcessCaptureRead.js";
import { observeSelectedExecutable } from "../../../src/process/capture/ProcessCaptureLifecycle.js";

const roots: string[] = [];
const createExecutable = async (content: string): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "rea-selected-executable-owner-"));
  roots.push(root);
  const path = join(root, "selected-fixture");
  await writeFile(path, content);
  return path;
};

const caughtFailure = async (
  operation: () => Promise<unknown>,
): Promise<ProcessCaptureReadFailure<unknown>> => {
  let cause: unknown;
  try {
    await operation();
  } catch (error: unknown) {
    cause = error;
  }
  expect(cause).toBeInstanceOf(ProcessCaptureReadFailure);
  return cause as ProcessCaptureReadFailure<unknown>;
};

afterEach(async () => {
  for (const handle of injected.handles.splice(0)) {
    handle.restore();
    if (!handle.isOpen()) continue;
    try {
      await handle.close();
    } catch (cause: unknown) {
      if (
        handle.isOpen() ||
        !(cause instanceof Error && "code" in cause && cause.code === "EBADF")
      )
        throw cause;
    }
  }
  injected.path = "";
  injected.closeFailure = undefined;
  injected.primaryFailure = undefined;
  injected.abortOnClose = undefined;
  injected.abortOnRead = undefined;
  injected.readFailure = undefined;
  injected.opened = [];
  injected.closed = [];
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

it("retains the completed executable observation and descriptor owner after close failure", async () => {
  const bytes = "small selected executable fixture";
  const path = await createExecutable(bytes);
  injected.path = path;
  injected.closeFailure = new Error(
    "injected selected executable close denial",
  );
  const scope = new ProcessCaptureResourceScope();

  const failure = await caughtFailure(() =>
    scope.run(() =>
      observeSelectedExecutable(path, undefined, undefined, scope),
    ),
  );
  expect(failure.outcome.kind).toBe("completed");
  if (failure.outcome.kind === "completed")
    expect(failure.outcome.value).toMatchObject({
      sha256: createHash("sha256").update(bytes).digest("hex"),
      identity: expect.any(Object),
      reason: null,
    });
  expect(failure.cleanupCause).toBe(injected.closeFailure);
  expect(failure.cleanupLeases).toHaveLength(1);
  expect(injected.opened).toEqual([path]);

  await expect(
    scope.run(() =>
      observeSelectedExecutable(path, undefined, undefined, scope),
    ),
  ).rejects.toMatchObject({ cleanupIncomplete: true });
  expect(injected.opened).toEqual([path]);

  injected.closeFailure = undefined;
  await scope.retryCleanup();
  expect(failure.cleanupIncomplete).toBe(false);
  await expect(
    scope.run(() =>
      observeSelectedExecutable(path, undefined, undefined, scope),
    ),
  ).resolves.toMatchObject({
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
  expect(injected.opened).toEqual([path, path]);
  expect(injected.handles).toHaveLength(2);
  expect(injected.handles.every((handle) => !handle.isOpen())).toBe(true);
  await scope.close();
});

it("preserves selected executable IO failure when descriptor close also fails", async () => {
  const path = await createExecutable(
    "selected executable with primary IO failure",
  );
  const primary = new Error("injected selected executable metadata failure");
  injected.path = path;
  injected.closeFailure = new Error(
    "injected selected executable close denial",
  );
  const scope = new ProcessCaptureResourceScope();
  const fileSystem = {
    open,
    stat: async () => {
      throw primary;
    },
  };

  const failure = await caughtFailure(() =>
    observeSelectedExecutable(path, undefined, fileSystem, scope),
  );
  expect(failure.outcome).toMatchObject({ kind: "failed", cause: primary });
  expect(failure.cause).toBe(primary);
  expect(failure.cleanupCause).toBe(injected.closeFailure);
  expect(failure.cleanupLeases).toHaveLength(1);

  injected.closeFailure = undefined;
  await scope.retryCleanup();
  expect(failure.cleanupIncomplete).toBe(false);
  await scope.close();
});

it("keeps the exact cancellation reason when cancellation arrives during descriptor close", async () => {
  const path = await createExecutable(
    "selected executable cancelled during close",
  );
  const controller = new AbortController();
  const reason = new Error("cancel during selected executable close");
  const closeFailure = new Error("injected close denial after cancellation");
  injected.path = path;
  injected.closeFailure = closeFailure;
  injected.abortOnClose = () => controller.abort(reason);
  const scope = new ProcessCaptureResourceScope();

  const failure = await caughtFailure(() =>
    observeSelectedExecutable(path, controller.signal, undefined, scope),
  );
  expect(failure.outcome.kind).toBe("completed");
  expect(failure.cause).toBe(reason);
  expect(failure.cancellation).toEqual({ reason });
  expect(failure.cleanupCause).toBe(closeFailure);
  expect(failure.userCategory).toBe("cancelled");
  expect(failure.cleanupLeases).toHaveLength(1);

  injected.abortOnClose = undefined;
  injected.closeFailure = undefined;
  await scope.retryCleanup();
  expect(failure.cleanupIncomplete).toBe(false);
  await scope.close();
});

it("returns a completed executable observation when descriptor close succeeds without cancellation", async () => {
  const bytes = "successful selected executable fixture";
  const path = await createExecutable(bytes);
  injected.path = path;
  const scope = new ProcessCaptureResourceScope();

  await expect(
    scope.run(() =>
      observeSelectedExecutable(path, undefined, undefined, scope),
    ),
  ).resolves.toMatchObject({
    sha256: createHash("sha256").update(bytes).digest("hex"),
    identity: expect.any(Object),
    reason: null,
  });
  expect(injected.opened).toEqual([path]);
  expect(injected.handles).toHaveLength(1);
  expect(injected.handles[0]?.isOpen()).toBe(false);
  await scope.close();
});

it.each(["none", "read", "close"] as const)(
  "retains read, cancellation and close facts when cancellation arrives during %s",
  async (phase) => {
    const path = await createExecutable("selected executable read rejection");
    const readFailure = Object.assign(
      new Error("injected executable read failure"),
      { code: "EIO" },
    );
    const closeFailure = new Error("injected executable close failure");
    const controller = new AbortController();
    const reason = new Error(
      "cancel while selected executable read is pending",
    );
    injected.path = path;
    injected.readFailure = readFailure;
    injected.closeFailure = closeFailure;
    if (phase === "read") injected.abortOnRead = () => controller.abort(reason);
    if (phase === "close")
      injected.abortOnClose = () => controller.abort(reason);
    const scope = new ProcessCaptureResourceScope();
    const failure = await caughtFailure(() =>
      scope.run(() =>
        observeSelectedExecutable(path, controller.signal, undefined, scope),
      ),
    );
    expect(failure.cleanupCause).toBe(closeFailure);
    expect(failure.cleanupIncomplete).toBe(true);
    expect(failure.cleanupLeases).toHaveLength(1);
    expect(failure.outcome.kind).toBe("failed");
    if (failure.outcome.kind !== "failed")
      throw new Error("Expected the physical read failure");
    if (phase === "read") {
      expect(failure.cause).toBe(reason);
      expect(failure.cancellation?.reason).toBe(reason);
      expect(failure.userCategory).toBe("cancelled");
      expect(failure.outcome.cause).toBeInstanceOf(
        RegularFileOperationCancelled,
      );
      if (!(failure.outcome.cause instanceof RegularFileOperationCancelled))
        throw new Error("Expected recorded read cancellation");
      expect(failure.outcome.cause.cause).toBe(readFailure);
    } else {
      // A later abort during close must not relabel an already failed read.
      expect(failure.cause).toBe(readFailure);
      expect(failure.outcome.cause).toBe(readFailure);
      expect(failure.cancellation).toBeUndefined();
    }
    expect(injected.handles[0]?.isOpen()).toBe(true);
    injected.abortOnClose = undefined;
    injected.closeFailure = undefined;
    await scope.retryCleanup();
    expect(failure.cleanupIncomplete).toBe(false);
    expect(injected.handles[0]?.isOpen()).toBe(false);
    expect(failure.cleanupCause).toBe(closeFailure);
    await scope.close();
  },
);
