import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  GHIDRA_PROJECT_REPAIR_STAGING_DIRECTORY,
  GHIDRA_PROJECT_STAGING_DIRECTORY,
} from "./GhidraProjectCacheTypes.js";
import { GhidraProjectStore } from "./GhidraProjectStore.js";

/**
 * The cache root is the path the caller chose, so a parent another principal
 * can write can hold a link at its name. A maintenance operation that follows
 * that link lists and removes what the other directory holds, so the store
 * refuses the root before it reads or removes anything.
 */
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

/**
 * Create a directory link at `path`.
 *
 * Windows uses a junction, which needs no elevated privilege, and the store
 * refuses both the same way: the link is reported as a symbolic link.
 */
const linkDirectory = async (target: string, path: string): Promise<void> => {
  await symlink(
    target,
    path,
    process.platform === "win32" ? "junction" : "dir",
  );
};

describe("GhidraProjectStore root admission", () => {
  it("refuses a linked root and leaves the directory it names untouched", async () => {
    const parent = await tempRoot();
    const foreign = join(parent, "foreign");
    const staging = join(foreign, GHIDRA_PROJECT_STAGING_DIRECTORY);
    const repairs = join(foreign, GHIDRA_PROJECT_REPAIR_STAGING_DIRECTORY);
    await mkdir(staging, { recursive: true });
    await mkdir(repairs, { recursive: true });
    await writeFile(join(staging, "copy"), "another session's copy");
    await writeFile(join(repairs, "copy"), "another session's repair copy");
    const linked = join(parent, "cache");
    await linkDirectory(foreign, linked);
    const store = new GhidraProjectStore({
      root: linked,
      maxBytes: 1_000_000,
      platform: "linux",
    });

    const pruned = await store.prune();
    expect(pruned.ok).toBe(false);
    if (pruned.ok) throw new Error("expected a refused root");
    expect(pruned.error.reason).toBe("root");
    expect(pruned.error.path).toBe(linked);

    // The directory the link names keeps its children: the prune neither
    // removed the abandoned staging copy nor the repair copies.
    await expect(readFile(join(staging, "copy"), "utf8")).resolves.toBe(
      "another session's copy",
    );
    await expect(readFile(join(repairs, "copy"), "utf8")).resolves.toBe(
      "another session's repair copy",
    );
  });

  it("refuses a linked root before it lists or verifies what the root holds", async () => {
    const parent = await tempRoot();
    const foreign = join(parent, "foreign");
    await mkdir(foreign, { recursive: true });
    await writeFile(join(foreign, "stray"), "not an entry");
    const linked = join(parent, "cache");
    await linkDirectory(foreign, linked);
    const store = new GhidraProjectStore({
      root: linked,
      maxBytes: 1_000_000,
      platform: "linux",
    });

    const listed = await store.list();
    expect(listed.ok).toBe(false);
    if (listed.ok) throw new Error("expected a refused root");
    expect(listed.error.reason).toBe("root");

    const verified = await store.verify();
    expect(verified.ok).toBe(false);
    if (verified.ok) throw new Error("expected a refused root");
    expect(verified.error.reason).toBe("root");

    const removed = await store.remove("a".repeat(64));
    expect(removed.ok).toBe(false);
    if (removed.ok) throw new Error("expected a refused root");
    expect(removed.error.reason).toBe("root");
    await expect(readFile(join(foreign, "stray"), "utf8")).resolves.toBe(
      "not an entry",
    );
  });

  it("reports an empty store for a root that does not exist", async () => {
    const parent = await tempRoot();
    const missing = join(parent, "missing");
    const store = new GhidraProjectStore({
      root: missing,
      maxBytes: 1_000_000,
      platform: "linux",
    });

    const listed = await store.list();
    expect(listed.ok && listed.value).toEqual([]);
    const verified = await store.verify();
    expect(verified.ok && verified.value).toEqual([]);
    const pruned = await store.prune();
    expect(pruned.ok && pruned.value).toEqual({ removed: [], bytes: 0 });
    const removed = await store.remove("a".repeat(64));
    expect(removed.ok && removed.value).toBe(false);
    // A maintenance operation reports what the root holds; it does not
    // create the root.
    await expect(stat(missing)).rejects.toThrow();
  });
});
