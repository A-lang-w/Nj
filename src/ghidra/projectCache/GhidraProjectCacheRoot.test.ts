import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ensureGhidraProjectCacheRoot,
  type GhidraProjectCacheRootHost,
} from "./GhidraProjectCacheRoot.js";

const roots: string[] = [];
const tempRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "rea-ghidra-cache-root-"));
  roots.push(root);
  return root;
};

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

/** A native host that creates the durable root directly and always verifies. */
const privateRootHost = (
  overrides: Partial<GhidraProjectCacheRootHost> = {},
): GhidraProjectCacheRootHost => ({
  async createPrivateDirectory(root) {
    await mkdir(root, { recursive: true });
    return root;
  },
  verifyPrivateDirectory() {
    return { privateDacl: true };
  },
  ...overrides,
});

describe("POSIX cache root", () => {
  it("creates a directory before a project is stored", async () => {
    const parent = await tempRoot();
    const root = join(parent, "nested", "cache");
    await expect(
      ensureGhidraProjectCacheRoot(root, { platform: "linux" }),
    ).resolves.toEqual({ status: "ready" });
    await expect(
      lstat(root).then((stats) => stats.isDirectory()),
    ).resolves.toBe(true);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "tightens an existing group- or world-accessible root",
    async () => {
      const root = await tempRoot();
      await chmod(root, 0o755);
      await ensureGhidraProjectCacheRoot(root, { platform: "linux" });
      const stats = await lstat(root);
      expect(stats.mode & 0o077).toBe(0);
    },
  );

  it("rejects a root that is a link", async () => {
    const parent = await tempRoot();
    const target = join(parent, "target");
    const root = join(parent, "cache");
    await mkdir(target);
    await symlink(target, root);
    await expect(
      ensureGhidraProjectCacheRoot(root, { platform: "linux" }),
    ).rejects.toMatchObject({ reason: "io", path: root });
  });
});

describe("Windows cache root", () => {
  it("creates the leaf through the native private-DACL boundary", async () => {
    const parent = await tempRoot();
    const root = join(parent, "cache");
    const created: string[] = [];
    const verified: string[] = [];
    await ensureGhidraProjectCacheRoot(root, {
      platform: "win32",
      host: privateRootHost({
        async createPrivateDirectory(path) {
          created.push(path);
          await mkdir(path, { recursive: true });
          return path;
        },
        verifyPrivateDirectory(path) {
          verified.push(path);
          return { privateDacl: true };
        },
      }),
    });
    await expect(
      lstat(root).then((stats) => stats.isDirectory()),
    ).resolves.toBe(true);
    expect(created).toEqual([root]);
    expect(verified).toEqual([root]);
  });

  it("accepts an existing root only after native verification", async () => {
    const parent = await tempRoot();
    const root = join(parent, "cache");
    await mkdir(root);
    await writeFile(join(root, "entry"), "private");
    const verified: string[] = [];
    await ensureGhidraProjectCacheRoot(root, {
      platform: "win32",
      host: privateRootHost({
        async createPrivateDirectory() {
          throw new Error("an existing root must not be recreated");
        },
        verifyPrivateDirectory(path) {
          verified.push(path);
          return { privateDacl: true };
        },
      }),
    });
    expect(verified).toEqual([root]);
    await expect(readFile(join(root, "entry"), "utf8")).resolves.toBe(
      "private",
    );
  });
});

describe("Windows cache root repair", () => {
  it("rebuilds an existing root that is not owner-only", async () => {
    const parent = await tempRoot();
    const root = join(parent, "cache");
    await mkdir(root);
    await writeFile(join(root, "entry"), "stored");
    const created: string[] = [];
    const verified: string[] = [];
    // Only the root that was already there is not owner-only; the rebuilt one
    // passes the same native verification.
    let inspected = false;
    const outcome = await ensureGhidraProjectCacheRoot(root, {
      platform: "win32",
      host: privateRootHost({
        async createPrivateDirectory(path) {
          created.push(path);
          await mkdir(path, { recursive: true });
          return path;
        },
        verifyPrivateDirectory(path) {
          verified.push(path);
          if (!inspected) {
            inspected = true;
            throw new Error("Private object owner is not the current user");
          }
          return { privateDacl: true };
        },
      }),
    });
    expect(outcome).toEqual({ status: "repaired", preservedEntries: 1 });
    // The stored project survives the rebuild.
    await expect(readFile(join(root, "entry"), "utf8")).resolves.toBe("stored");
    expect(created).toEqual([root]);
    expect(verified).toEqual([root, root]);
    // The set-aside root is removed after the replacement is in place.
    await expect(readdir(parent)).resolves.toEqual(["cache"]);
  });

  it("restores the previous root when the rebuild cannot start", async () => {
    const parent = await tempRoot();
    const root = join(parent, "cache");
    await mkdir(root);
    await writeFile(join(root, "entry"), "stored");
    await expect(
      ensureGhidraProjectCacheRoot(root, {
        platform: "win32",
        host: privateRootHost({
          async createPrivateDirectory() {
            throw new Error("the native boundary is unavailable");
          },
          verifyPrivateDirectory() {
            throw new Error("Private object owner is not the current user");
          },
        }),
      }),
    ).rejects.toMatchObject({
      reason: "io",
      path: root,
      message: expect.stringContaining(
        "could not be rebuilt as a private directory",
      ),
    });
    // The previous root keeps the stored project and its name.
    await expect(readFile(join(root, "entry"), "utf8")).resolves.toBe("stored");
    await expect(readdir(parent)).resolves.toEqual(["cache"]);
  });

  it("keeps the stored project when the rebuilt root is not owner-only", async () => {
    const parent = await tempRoot();
    const root = join(parent, "cache");
    await mkdir(root);
    await writeFile(join(root, "entry"), "stored");
    await expect(
      ensureGhidraProjectCacheRoot(root, {
        platform: "win32",
        host: privateRootHost({
          async createPrivateDirectory(path) {
            await mkdir(path, { recursive: true });
            return path;
          },
          verifyPrivateDirectory() {
            throw new Error("Private DACL contains unexpected trustees");
          },
        }),
      }),
    ).rejects.toMatchObject({
      reason: "io",
      path: root,
      message: expect.stringContaining("could not be verified as owner-only"),
    });
    // The stored project is in the rebuilt root; it is never discarded.
    await expect(readFile(join(root, "entry"), "utf8")).resolves.toBe("stored");
    await expect(readdir(parent)).resolves.toEqual(["cache"]);
  });

  it("rejects a linked root before verification", async () => {
    const parent = await tempRoot();
    const target = join(parent, "target");
    const root = join(parent, "cache");
    await mkdir(target);
    await symlink(target, root);
    let verified = false;
    await expect(
      ensureGhidraProjectCacheRoot(root, {
        platform: "win32",
        host: privateRootHost({
          async createPrivateDirectory() {
            throw new Error("a linked root must not be recreated");
          },
          verifyPrivateDirectory() {
            verified = true;
            return { privateDacl: true };
          },
        }),
      }),
    ).rejects.toMatchObject({ reason: "io", path: root });
    expect(verified).toBe(false);
  });
});

describe("Windows cache root admission", () => {
  it("rejects an existing root that is not a directory", async () => {
    const parent = await tempRoot();
    const root = join(parent, "cache");
    await writeFile(root, "not a directory");
    await expect(
      ensureGhidraProjectCacheRoot(root, {
        platform: "win32",
        host: privateRootHost({
          async createPrivateDirectory() {
            throw new Error("a file root must not be recreated");
          },
          verifyPrivateDirectory() {
            throw new Error("a file root must not be verified");
          },
        }),
      }),
    ).rejects.toMatchObject({
      reason: "io",
      path: root,
      message: expect.stringContaining("must be a directory"),
    });
  });

  it("reports a root that could not be created privately", async () => {
    const parent = await tempRoot();
    const root = join(parent, "cache");
    const created: string[] = [];
    await expect(
      ensureGhidraProjectCacheRoot(root, {
        platform: "win32",
        host: privateRootHost({
          async createPrivateDirectory(path) {
            // The native leaf is reported but never created, so the rename
            // fails and no root appears.
            created.push(path);
            throw new Error("the native boundary is unavailable");
          },
          verifyPrivateDirectory() {
            throw new Error("an unverified root must not be accepted");
          },
        }),
      }),
    ).rejects.toMatchObject({
      reason: "io",
      path: root,
      message: expect.stringContaining("could not be created privately"),
    });
    expect(created).toHaveLength(1);
    await expect(access(root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a created root that native verification does not confirm", async () => {
    const parent = await tempRoot();
    const root = join(parent, "cache");
    await expect(
      ensureGhidraProjectCacheRoot(root, {
        platform: "win32",
        host: privateRootHost({
          async createPrivateDirectory(path) {
            await mkdir(path, { recursive: true });
            return path;
          },
          verifyPrivateDirectory() {
            throw new Error("unexpected trustee");
          },
        }),
      }),
    ).rejects.toMatchObject({
      reason: "io",
      path: root,
      message: expect.stringContaining("could not be verified as owner-only"),
    });
  });
});

describe("Windows cache root concurrency", () => {
  it("accepts a root a concurrent initializer created only after native verification", async () => {
    const parent = await tempRoot();
    const root = join(parent, "cache");
    const created: string[] = [];
    const verified: string[] = [];
    await ensureGhidraProjectCacheRoot(root, {
      platform: "win32",
      host: privateRootHost({
        async createPrivateDirectory(path) {
          created.push(path);
          // The concurrent initializer wins the name and holds a populated
          // directory, so the durable root cannot be renamed over it.
          mkdirSync(root, { recursive: true });
          writeFileSync(join(root, "entry"), "private");
          throw new Error("the name was taken by a concurrent initializer");
        },
        verifyPrivateDirectory(path) {
          verified.push(path);
          return { privateDacl: true };
        },
      }),
    });
    // A durable root was attempted, so the rename was tried and lost.
    expect(created).toHaveLength(1);
    expect(verified).toEqual([root]);
    // The root the concurrent initializer owns is kept, not replaced.
    await expect(readFile(join(root, "entry"), "utf8")).resolves.toBe(
      "private",
    );
  });

  it("rejects a root a concurrent initializer created that is not owner-only", async () => {
    const parent = await tempRoot();
    const root = join(parent, "cache");
    const created: string[] = [];
    await expect(
      ensureGhidraProjectCacheRoot(root, {
        platform: "win32",
        host: privateRootHost({
          async createPrivateDirectory(path) {
            created.push(path);
            // The concurrent initializer wins the name with a shared directory.
            mkdirSync(root, { recursive: true });
            writeFileSync(join(root, "entry"), "shared");
            throw new Error("the name was taken by a concurrent initializer");
          },
          verifyPrivateDirectory() {
            throw new Error("unexpected trustee");
          },
        }),
      }),
    ).rejects.toMatchObject({
      reason: "io",
      path: root,
      message: expect.stringContaining("could not be verified as owner-only"),
    });
    expect(created).toHaveLength(1);
  });

  it("rejects a linked root a concurrent initializer created", async () => {
    const parent = await tempRoot();
    const target = join(parent, "target");
    const root = join(parent, "cache");
    const created: string[] = [];
    const verified: string[] = [];
    await expect(
      ensureGhidraProjectCacheRoot(root, {
        platform: "win32",
        host: privateRootHost({
          async createPrivateDirectory(path) {
            created.push(path);
            // The concurrent initializer wins the name with a link.
            mkdirSync(target);
            symlinkSync(target, root, "dir");
            throw new Error("the name was taken by a concurrent initializer");
          },
          verifyPrivateDirectory(path) {
            verified.push(path);
            return { privateDacl: true };
          },
        }),
      }),
    ).rejects.toMatchObject({
      reason: "io",
      path: root,
      message: expect.stringContaining("must be a directory"),
    });
    // A link is refused before native verification.
    expect(verified).toEqual([]);
    expect(created).toHaveLength(1);
  });
});
