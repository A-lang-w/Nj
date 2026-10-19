import { createHash } from "node:crypto";
import { lstat, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

const observation = vi.hoisted(() => ({
  path: "",
  cancelAfterDescriptorInspection: false,
  descriptorInspected: false,
  controller: undefined as AbortController | undefined,
  reason: undefined as Error | undefined,
  handles: [] as FileHandle[],
}));

// Force the capability fallback while keeping actual filesystem IO. These
// cases establish cancellation semantics, not native Windows compatibility.
vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return {
    ...original,
    constants: { ...original.constants, O_NOFOLLOW: 0 },
  };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    open: async (...args: Parameters<typeof original.open>) => {
      const handle = await original.open(...args);
      if (args[0] === observation.path) {
        observation.handles.push(handle);
        const stat = handle.stat.bind(handle);
        vi.spyOn(handle, "stat").mockImplementation(async (options) => {
          const stats = await stat(options);
          observation.descriptorInspected = true;
          return stats;
        });
      }
      return handle;
    },
    lstat: async (...args: Parameters<typeof original.lstat>) => {
      const stats = await original.lstat(...args);
      if (
        args[0] === observation.path &&
        observation.cancelAfterDescriptorInspection &&
        observation.descriptorInspected
      )
        observation.controller?.abort(observation.reason);
      return stats;
    },
  };
});

import { parseProcessScenario } from "../../src/domain/process/processScenario.js";
import {
  hashFile,
  ProcessCaptureSnapshotFailure,
  snapshotRoots,
} from "../../src/process/capture/FilesystemSnapshot.js";
import { ProcessCaptureReadFailure } from "../../src/process/capture/ProcessCaptureRead.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";

afterEach(() => {
  observation.path = "";
  observation.cancelAfterDescriptorInspection = false;
  observation.descriptorInspected = false;
  observation.controller = undefined;
  observation.reason = undefined;
  observation.handles.length = 0;
});

it.each(["hash", "snapshot"] as const)(
  "rejects cancellation during the final %s fallback inspection and closes the descriptor",
  async (operation) => {
    const directory = await createTestTempDirectory("rea-fs-fallback-cancel-");
    const path = join(directory, "observed-file");
    await writeFile(path, "captured bytes");
    const expected = await lstat(path);
    const controller = new AbortController();
    const reason = Object.assign(
      new Error("cancelled during final named-file inspection"),
      { code: "EACCES" },
    );
    observation.path = path;
    observation.controller = controller;
    observation.reason = reason;
    // The final fallback inspection is the named lookup after the opened
    // descriptor was inspected. Admission may perform other named lookups.
    observation.cancelAfterDescriptorInspection = true;
    const scenario = parseProcessScenario({
      executable: process.execPath,
      working_directory: directory,
      filesystem_observation_paths: [path],
    });
    const result =
      operation === "hash"
        ? hashFile(path, expected, 1_000, controller.signal)
        : snapshotRoots(scenario, controller.signal);
    const failure = await result.catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(
      operation === "hash"
        ? ProcessCaptureReadFailure
        : ProcessCaptureSnapshotFailure,
    );
    if (
      !(
        failure instanceof ProcessCaptureReadFailure ||
        failure instanceof ProcessCaptureSnapshotFailure
      )
    )
      throw failure;
    expect(failure.cause).toBe(reason);
    expect(failure.reason).toBe("cancelled");
    expect(failure.userCategory).toBe("cancelled");
    expect(failure.cleanupIncomplete).toBe(false);
    expect(failure.cleanupLeases).toEqual([]);
    if (failure instanceof ProcessCaptureSnapshotFailure) {
      expect(failure.snapshot).toEqual({
        files: [],
        completeRoots: [],
        truncated: true,
        coverage: {
          files_limit: scenario.limits.files,
          depth_limit: scenario.limits.filesystem_depth,
          enumeration_truncated: true,
          enumeration_reasons: [],
          enumeration_omissions: [],
          hash_budget_bytes: scenario.limits.file_bytes,
          hashed_bytes: 0,
          hash_omissions: [],
        },
      });
      expect(failure.readFailures).toHaveLength(1);
    }
    const readFailure =
      failure instanceof ProcessCaptureSnapshotFailure
        ? failure.readFailures[0]
        : failure;
    expect(readFailure).toBeInstanceOf(ProcessCaptureReadFailure);
    if (!(readFailure instanceof ProcessCaptureReadFailure)) throw readFailure;
    expect(readFailure.path).toBe(path);
    expect(readFailure.cause).toBe(reason);
    expect(readFailure.cancellation?.reason).toBe(reason);
    expect(readFailure.outcome.kind).toBe("failed");
    if (readFailure.outcome.kind !== "failed")
      throw new Error("Expected interrupted read");
    expect(readFailure.outcome.cause).toBe(reason);
    expect(readFailure.cleanupIncomplete).toBe(false);
    expect(readFailure.cleanupLeases).toEqual([]);
    expect(controller.signal.aborted).toBe(true);
    expect(observation.handles).toHaveLength(1);
    await expect(observation.handles[0]?.stat()).rejects.toMatchObject({
      code: "EBADF",
    });
  },
);

it("keeps an unchanged fallback digest and closes its descriptor", async () => {
  const directory = await createTestTempDirectory("rea-fs-fallback-digest-");
  const path = join(directory, "observed-file");
  const bytes = Buffer.from("captured bytes");
  await writeFile(path, bytes);
  const expected = await lstat(path);
  observation.path = path;
  await expect(hashFile(path, expected, 1_000)).resolves.toEqual({
    state: "hashed",
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
  expect(observation.descriptorInspected).toBe(true);
  expect(observation.handles).toHaveLength(1);
  await expect(observation.handles[0]?.stat()).rejects.toMatchObject({
    code: "EBADF",
  });
});
