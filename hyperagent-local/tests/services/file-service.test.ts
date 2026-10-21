import { describe, it, expect, vi, afterEach } from "vitest";
import {
  saveFile,
  getFiles,
  deleteFile,
} from "../../src/services/file-service.js";
import { subscribe } from "../../src/domain/events.js";
import fs from "node:fs";

// Runs against the isolated per-file database provisioned by
// tests/setup-env.ts (migrated schema, user 1 + workspace 1 seeded).
// The previous in-file tmp database was never passed to the services and
// has been removed; setting DATA_DIR here would also be too late, since
// the connection binds at import time.

describe("file-service", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("saves a file to disk and database", async () => {
    const content = Buffer.from("Hello, world!");
    const result = await saveFile(1, "test.txt", "text/plain", content, 1);
    expect(result.ok).toBe(true);
    if (!result.ok)
      throw new Error(`saveFile failed: ${result.error?.message}`);
    const file = result.value;
    expect(file).toBeDefined();
    expect(file.filename).toBe("test.txt");
    expect(file.sizeBytes).toBe(content.length);
    expect(fs.existsSync(file.storagePath)).toBe(true);
  });

  it("lists files for a workspace", async () => {
    const files = await getFiles(1);
    expect(files.length).toBeGreaterThanOrEqual(1);
  });

  it("deletes a file from disk and database", async () => {
    const content = Buffer.from("Delete me");
    const result = await saveFile(1, "delete-me.txt", "text/plain", content, 1);
    expect(result.ok).toBe(true);
    if (!result.ok)
      throw new Error(`saveFile failed: ${result.error?.message}`);
    const file = result.value;
    expect(fs.existsSync(file.storagePath)).toBe(true);
    await deleteFile(file.id, 1);
    expect(fs.existsSync(file.storagePath)).toBe(false);
    const remaining = await getFiles(1);
    expect(remaining.find((f) => f.id === file.id)).toBeUndefined();
  });

  it("assigns distinct storage paths to same-name uploads in the same millisecond", async () => {
    // Freeze the clock: with Date.now() as the only uniqueness source, both
    // uploads would share a storage path and the second rename would
    // silently overwrite the first file's bytes.
    vi.spyOn(Date, "now").mockReturnValue(1234567890000);
    const first = await saveFile(
      1,
      "collision.txt",
      "text/plain",
      Buffer.from("first-bytes"),
      1,
    );
    const second = await saveFile(
      1,
      "collision.txt",
      "text/plain",
      Buffer.from("second-bytes"),
      1,
    );
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok)
      throw new Error("saveFile failed under frozen clock");
    expect(second.value.storagePath).not.toBe(first.value.storagePath);
    expect(fs.readFileSync(first.value.storagePath, "utf8")).toBe(
      "first-bytes",
    );
    expect(fs.readFileSync(second.value.storagePath, "utf8")).toBe(
      "second-bytes",
    );
  });

  it("emits no deletion event for a nonexistent file", async () => {
    const seen: string[] = [];
    const unsubscribe = subscribe((event) => {
      seen.push(event);
    });
    try {
      await deleteFile(2147483647, 1);
    } finally {
      unsubscribe();
    }
    expect(seen).not.toContain("file.deleted");
  });
});
