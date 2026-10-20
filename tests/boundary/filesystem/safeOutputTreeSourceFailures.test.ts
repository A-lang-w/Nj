import { createHash } from "node:crypto";
import { access, open, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { expect, it, vi } from "vitest";
import { AnalysisCleanupLease } from "../../../src/artifacts/AnalysisCleanupLease.js";
import { ArtifactReaderFailure } from "../../../src/artifacts/ArtifactReader.js";
import { ArtifactResourceScope } from "../../../src/artifacts/ArtifactResourceScope.js";
import { withArtifactRegularFile } from "../../../src/artifacts/ArtifactFileOperation.js";
import { readArtifactFileChunks } from "../../../src/artifacts/readArtifactFileChunks.js";
import { SafeOutputTree } from "../../../src/artifacts/SafeOutputTree.js";
import { SafeOutputSourceCleanupFailure } from "../../../src/artifacts/SafeOutputSourceCleanupFailure.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

it.each([false, true])(
  "retains deferred source cleanup failure after path refusal (emitClose: %s)",
  async (emitClose) => {
    const root = await createTestTempDirectory("rea-source-double-failure-");
    const output = join(root, "output");
    const tree = await SafeOutputTree.create(output);
    const cleanup = new Error("source close failed");
    const source = new Readable({
      emitClose,
      read() {
        throw new Error("refused input must not be consumed");
      },
      destroy(_error, callback) {
        setImmediate(() => callback(cleanup));
      },
    });
    try {
      const failure = await tree
        .write("../outside", source, { bytes: 0, sha256: "" })
        .catch((cause: unknown) => cause);
      expect(failure).toBeInstanceOf(ArtifactReaderFailure);
      expect(failure).toMatchObject({
        reason: "path",
        cause: { reason: "path" },
        cleanup: { reason: cleanup.message, resources: [] },
      });
      expect((failure as ArtifactReaderFailure).cleanupLeases).toBeUndefined();
      expect(source.closed).toBe(true);
      expect(source.listenerCount("error")).toBe(0);
    } finally {
      expect(await tree.rollback()).toEqual({
        status: "complete",
        residualPaths: [],
      });
    }
    await expect(access(output)).rejects.toMatchObject({ code: "ENOENT" });
  },
);

it.each(
  (["integrity", "cancelled"] as const).flatMap((reason) =>
    [false, true].map((failCleanup) => ({ reason, failCleanup })),
  ),
)(
  "preserves an interrupted write without inventing cleanup failure: %j",
  async ({ reason, failCleanup }) => {
    const root = await createTestTempDirectory("rea-source-interrupted-");
    const tree = await SafeOutputTree.create(join(root, "output"));
    const controller = new AbortController();
    const cancellation = new DOMException(
      "publication deadline",
      "TimeoutError",
    );
    if (reason === "cancelled") controller.abort(cancellation);
    const cleanup = new Error("deferred cleanup failed");
    const source = new Readable({
      autoDestroy: false,
      read() {
        this.push(Buffer.from("owned"));
        this.push(null);
      },
      destroy(error, callback) {
        setImmediate(() => callback(failCleanup ? cleanup : error));
      },
    });
    try {
      const failure = await tree
        .write("file", source, { bytes: 0, sha256: "" }, controller.signal)
        .catch((cause: unknown) => cause);
      expect(failure).toBeInstanceOf(ArtifactReaderFailure);
      const typed = failure as ArtifactReaderFailure;
      expect(typed.reason).toBe(reason);
      if (reason === "cancelled")
        expect(typed.cancellation?.reason).toBe(cancellation);
      if (failCleanup)
        expect(typed.cleanup).toEqual({
          reason: cleanup.message,
          resources: [],
        });
      else expect(typed.cleanup).toBeUndefined();
      expect(source.closed).toBe(true);
    } finally {
      expect(await tree.rollback()).toEqual({
        status: "complete",
        residualPaths: [],
      });
    }
  },
);

it.each([false, true])(
  "retains a producer's exact cleanup lease alongside a path refusal (unknown peer: %s)",
  async (unknownPeer) => {
    const root = await createTestTempDirectory("rea-source-lease-");
    const input = join(root, "input");
    await writeFile(input, "owned");
    const handle = await open(input, "r");
    const lease = new AnalysisCleanupLease(() => handle.close(), [input]);
    const cleanup = new ArtifactReaderFailure("io", "source cleanup failed", {
      cleanup: { reason: "source descriptor close failed", resources: [input] },
      cleanupLeases: [lease],
    });
    const tree = await SafeOutputTree.create(join(root, "output"));
    const source = new Readable({
      read() {
        throw new Error("refused input must not be consumed");
      },
      destroy(_error, callback) {
        setImmediate(() => callback(cleanup));
      },
    });
    try {
      const pending = tree
        .write("../outside", source, { bytes: 0, sha256: "" })
        .catch((cause: unknown) => cause);
      const peer = new Error("source failure with unknown cleanup owner");
      if (unknownPeer) source.emit("error", peer);
      const failure = await pending;
      expect(failure).toBeInstanceOf(ArtifactReaderFailure);
      expect(failure).toBeInstanceOf(SafeOutputSourceCleanupFailure);
      const typed = failure as SafeOutputSourceCleanupFailure;
      expect(typed.reason).toBe("path");
      expect(typed.cleanup?.resources).toEqual([input]);
      expect(typed.cleanup?.reason).toContain("source descriptor close failed");
      expect(typed.sourceFailures).toContain(cleanup);
      if (unknownPeer) {
        expect(typed.cleanup?.reason).toContain(peer.message);
        expect(typed.cleanupLeases).toBeUndefined();
        expect(typed.sourceFailures).toContain(peer);
      } else expect(typed.cleanupLeases).toEqual([lease]);
      expect(source.closed).toBe(true);
      expect((await handle.stat()).size).toBe(5);
      const retainedSource = typed.sourceFailures.find(
        (failure) => failure === cleanup,
      );
      expect(retainedSource).toBe(cleanup);
      await (
        retainedSource as ArtifactReaderFailure
      ).cleanupLeases?.[0]?.release();
      await expect(handle.stat()).rejects.toMatchObject({ code: "EBADF" });
    } finally {
      await lease.release();
      expect(await tree.rollback()).toEqual({
        status: "complete",
        residualPaths: [],
      });
    }
  },
);

it.each([false, true])(
  "preserves descriptor ownership around the production chunk stream (close failure: %s)",
  async (failClose) => {
    const root = await createTestTempDirectory("rea-source-file-owner-");
    const input = join(root, "input");
    await writeFile(input, "owned");
    const tree = await SafeOutputTree.create(join(root, "output"));
    const resources = new ArtifactResourceScope();
    const cleanup = new Error("descriptor close failed");
    try {
      const failure = await withArtifactRegularFile(
        input,
        resources,
        undefined,
        async (handle) => {
          if (failClose)
            vi.spyOn(handle, "close").mockRejectedValueOnce(cleanup);
          return tree.write("../outside", readArtifactFileChunks(handle), {
            bytes: 5,
            sha256: createHash("sha256").update("owned").digest("hex"),
          });
        },
      ).catch((cause: unknown) => cause);
      expect(failure).toBeInstanceOf(ArtifactReaderFailure);
      const typed = failure as ArtifactReaderFailure;
      expect(typed.reason).toBe("path");
      expect(resources.hasPending).toBe(failClose);
      if (failClose) {
        expect(typed.cleanup).toEqual({
          reason: cleanup.message,
          resources: [input],
        });
        expect(typed.cleanupLeases).toHaveLength(1);
      } else expect(typed.cleanup).toBeUndefined();
      await resources.retryCleanup();
      expect(resources.hasPending).toBe(false);
      if (failClose) expect(typed.cleanupLeases?.[0]?.released).toBe(true);
    } finally {
      await resources.close();
      expect(await tree.rollback()).toEqual({
        status: "complete",
        residualPaths: [],
      });
    }
  },
);
