import { createHash } from "node:crypto";
import { type FileHandle, readFile, stat } from "node:fs/promises";
import { sep } from "node:path";

import { expect, test, vi } from "vitest";

import { AnalysisInputError } from "../../../src/domain/analysisErrorCore.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import { ProviderCleanupError } from "../../../src/domain/providerCleanupError.js";
import {
  createJadxProtocolFixture,
  verifyJadxFixtureCleanup,
} from "../../fixtures/android/jadx.js";

const state = vi.hoisted(() => ({
  enabled: false,
  change: false,
  fail: false,
  source: "",
  closeCalls: 0,
  opens: 0,
  handles: [] as { handle: FileHandle; close: () => Promise<void> }[],
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      if (
        state.enabled &&
        String(args[0]).endsWith(`${sep}target.apk`) &&
        args[1] === "wx"
      ) {
        state.opens += 1;
        if (state.change) await actual.appendFile(state.source, "changed");
        const close = handle.close.bind(handle);
        state.handles.push({ handle, close });
        handle.close = async () => {
          state.closeCalls += 1;
          if (state.fail)
            throw Object.assign(new Error("controlled snapshot close EIO"), {
              code: "EIO",
            });
          return close();
        };
      }
      return handle;
    },
  };
});

const snapshotResource = (resources: readonly string[]): string | undefined =>
  resources.find((resource) => resource.endsWith(`${sep}target.apk`));

test("keeps the stable-file diagnosis when snapshot close succeeds", async () => {
  const fixture = await createJadxProtocolFixture();
  state.source = fixture.apk;
  state.change = true;
  state.fail = false;
  state.enabled = true;
  state.closeCalls = 0;
  state.opens = 0;
  state.handles = [];
  try {
    const result = await fixture.service.execute("inspect_android_package", {
      path: fixture.apk,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(projectAnalysisError(result.error).code).toBe("invalid_request");
    expect(result.error).toBeInstanceOf(AnalysisInputError);
    expect(result.error.cause?.constructor.name).toBe(
      "AndroidSnapshotChangedError",
    );
    expect(result.error.cleanupIncomplete).toBe(false);
    expect(state.handles[0]?.handle.fd).toBe(-1);
    expect(fixture.launches).toHaveLength(0);
    await fixture.provider.close();
  } finally {
    state.enabled = false;
    state.fail = false;
    await fixture.provider.close().catch(() => undefined);
    await verifyJadxFixtureCleanup(fixture.launches);
  }
});

for (const mode of ["changed-close-failure", "completed-close-failure"] as const)
  test(`retains the destination descriptor when snapshot close fails (${mode})`, async () => {
    const fixture = await createJadxProtocolFixture();
    const sourceBytes = await readFile(fixture.apk);
    const sha256 = createHash("sha256").update(sourceBytes).digest("hex");
    state.source = fixture.apk;
    state.change = mode === "changed-close-failure";
    state.fail = true;
    state.enabled = true;
    state.closeCalls = 0;
    state.opens = 0;
    state.handles = [];
    try {
      const result = await fixture.service.execute("inspect_android_package", {
        path: fixture.apk,
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(projectAnalysisError(result.error).code).toBe(
        "cleanup_incomplete",
      );
      expect(result.error.cleanupIncomplete).toBe(true);
      expect(JSON.stringify(projectAnalysisError(result.error))).toContain(
        "controlled snapshot close EIO",
      );
      const owned = state.handles[0];
      if (owned === undefined) throw new Error("missing destination descriptor");
      expect(owned.handle.fd).toBeGreaterThanOrEqual(0);
      expect(state.opens).toBe(1);
      expect(fixture.launches).toHaveLength(0);
      const snapshot = snapshotResource(result.error.cleanupResources);
      expect(snapshot).toBeDefined();
      const workspace = snapshot?.slice(0, -`${sep}target.apk`.length);
      if (workspace === undefined) throw new Error("missing snapshot workspace");
      await expect(stat(workspace)).resolves.toMatchObject({
        isDirectory: expect.any(Function),
      });
      if (mode === "changed-close-failure") {
        expect(result.error.cleanupPrimary?.cleanupPrimary).toBeInstanceOf(
          AnalysisInputError,
        );
        expect(
          result.error.cleanupPrimary?.cleanupPrimary?.cause?.constructor.name,
        ).toBe("AndroidSnapshotChangedError");
        expect(
          projectAnalysisError(
            result.error.cleanupPrimary?.cleanupPrimary ?? result.error,
          ).code,
        ).toBe("invalid_request");
      } else {
        expect(result.error.cleanupPrimary).toBeInstanceOf(ProviderCleanupError);
        expect(result.error.cleanupPrimary?.diagnostics).toMatchObject({
          snapshot_copy: "completed",
          snapshot_sha256: sha256,
          snapshot_bytes: sourceBytes.length,
          reason: "controlled snapshot close EIO",
        });
        expect(result.error.partialObservation).toMatchObject({
          kind: "file-snapshot-hash",
          sha256,
          bytes: sourceBytes.length,
        });
      }

      const opens = state.opens;
      const closeCalls = state.closeCalls;
      const blocked = await fixture.service.execute(
        "inspect_android_package",
        { path: fixture.apk },
      );
      expect(blocked.ok).toBe(false);
      if (blocked.ok) return;
      expect(blocked.error.cleanupIncomplete).toBe(true);
      expect(state.opens).toBe(opens);
      expect(state.closeCalls).toBeGreaterThan(closeCalls);
      expect(owned.handle.fd).toBeGreaterThanOrEqual(0);
      await expect(stat(workspace)).resolves.toBeTruthy();

      const closeCallsBeforeShutdown = state.closeCalls;
      await expect(fixture.provider.close()).rejects.toMatchObject({
        cleanupIncomplete: true,
      });
      expect(state.closeCalls).toBeGreaterThan(closeCallsBeforeShutdown);
      expect(owned.handle.fd).toBeGreaterThanOrEqual(0);
      expect(result.error.cleanupIncomplete).toBe(true);
      await expect(stat(workspace)).resolves.toBeTruthy();

      state.fail = false;
      await fixture.provider.close();
      expect(owned.handle.fd).toBe(-1);
      expect(result.error.cleanupIncomplete).toBe(false);
      expect(blocked.error.cleanupIncomplete).toBe(false);
      await expect(stat(workspace)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      state.enabled = false;
      state.fail = false;
      await fixture.provider.close().catch(() => undefined);
      for (const owned of state.handles)
        if (owned.handle.fd >= 0) await owned.close().catch(() => undefined);
      await verifyJadxFixtureCleanup(fixture.launches);
    }
  });
