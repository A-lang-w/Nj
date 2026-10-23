import type { FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  rejectClose: false,
  rejectMode: false,
  handles: [] as FileHandle[],
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    open: async (...args: Parameters<typeof original.open>) => {
      const handle = await original.open(...args);
      if (typeof args[1] === "number" && (args[1] & 3) === 2) {
        state.handles.push(handle);
        const close = handle.close.bind(handle);
        handle.close = async () => {
          if (state.rejectClose)
            throw new Error("injected skill close failure");
          await close();
        };
        const chmod = handle.chmod.bind(handle);
        handle.chmod = async (mode) => {
          if (state.rejectMode) throw new Error("injected skill mode failure");
          await chmod(mode);
        };
      }
      return handle;
    },
  };
});

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { ArtifactResourceScope } from "../../src/artifacts/ArtifactResourceScope.js";
import { ClientConfigurationPublicationFailure } from "../../src/application/ClientConfigurationCleanup.js";
import {
  installCanonicalSkill,
  skillDestinations,
  systemSkillInstallFileOperations,
} from "../../src/application/SetupSkill.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";

afterEach(() => {
  state.rejectClose = false;
  state.rejectMode = false;
  state.handles = [];
});

it.each([false, true])(
  "retains every failed skill publication cleanup owner when preparation failure is %s",
  async (rejectMode) => {
    const home = await createTestTempDirectory("rea-skill-cleanup-owners-");
    const resources = new ArtifactResourceScope();
    state.rejectClose = true;
    state.rejectMode = rejectMode;
    try {
      const pending = installCanonicalSkill(
        home,
        [],
        {},
        process.platform,
        undefined,
        resources,
      );
      if (rejectMode) {
        const result = await pending;
        if (result.ok) throw new Error("Expected staging preparation failure");
        expect(result.error.reason).toContain("cleanup remains incomplete");
        expect(result.error.cause).toBeInstanceOf(
          ClientConfigurationPublicationFailure,
        );
      } else {
        await expect(pending).rejects.toBeInstanceOf(
          ClientConfigurationPublicationFailure,
        );
      }
      expect(resources.hasPending).toBe(true);
      expect(state.handles).toHaveLength(rejectMode ? 1 : 7);
      expect(state.handles.every((handle) => handle.fd !== -1)).toBe(true);
      state.rejectClose = false;
      await resources.close();
      expect(resources.hasPending).toBe(false);
      expect(state.handles.every((handle) => handle.fd === -1)).toBe(true);
      const [destination] = skillDestinations(home, []);
      if (destination === undefined)
        throw new Error("Missing shared skill root");
      const remaining = [
        ...(await readdir(destination.path)),
        ...(await readdir(join(destination.path, "references"))),
      ];
      expect(remaining.some((entry) => entry.startsWith(".rea-config-"))).toBe(
        false,
      );
    } finally {
      state.rejectClose = false;
      await resources.close();
    }
  },
);

it.each([false, true])(
  "preserves a later write failure when earlier publication cleanup fails: %s",
  async (rejectClose) => {
    const home = await createTestTempDirectory("rea-skill-primary-cleanup-");
    const [destination] = skillDestinations(home, []);
    if (destination === undefined) throw new Error("Missing shared skill root");
    const manifest = join(destination.path, "SKILL.md");
    const connection = join(
      destination.path,
      "references/connection-and-recovery.md",
    );
    const original = "previously installed skill instructions\n";
    const failure = new Error("injected later write failure");
    await mkdir(dirname(manifest), { recursive: true });
    await writeFile(manifest, original);
    const resources = new ArtifactResourceScope();
    state.rejectClose = rejectClose;
    try {
      const result = await installCanonicalSkill(
        home,
        [],
        {},
        process.platform,
        {
          ...systemSkillInstallFileOperations,
          write: async (...args) => {
            if (args[0] === connection) throw failure;
            return systemSkillInstallFileOperations.write(...args);
          },
        },
        resources,
      );
      if (result.ok) throw new Error("Expected the later write failure");
      expect(result.error.path).toBe(connection);
      expect(result.error.stage).toBe("write");
      expect(result.error.reason).toBe(failure.message);
      expect(result.error.message).toContain(
        `REA skill write failed at ${connection}: ${failure.message}.`,
      );
      expect(result.error.rollbackFailures).toEqual(
        rejectClose
          ? [
              {
                path: manifest,
                reason: expect.stringContaining("cleanup remains incomplete"),
              },
            ]
          : [],
      );
      expect(result.error.recoveryBackupPaths).toEqual([
        `${manifest}.rea.backup`,
      ]);
      expect(await readFile(manifest, "utf8")).toBe(original);
      expect(await readFile(`${manifest}.rea.backup`, "utf8")).toBe(original);
      expect(resources.hasPending).toBe(rejectClose);
      expect(state.handles).toHaveLength(1);
      expect(state.handles[0]!.fd === -1).toBe(!rejectClose);
      state.rejectClose = false;
      await resources.close();
      expect(resources.hasPending).toBe(false);
      expect(state.handles[0]!.fd).toBe(-1);
      expect(
        (await readdir(destination.path)).some((entry) =>
          entry.startsWith(".rea-config-"),
        ),
      ).toBe(false);
    } finally {
      state.rejectClose = false;
      await resources.close();
    }
  },
);
