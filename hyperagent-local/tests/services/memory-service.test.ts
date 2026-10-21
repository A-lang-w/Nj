import { describe, it, expect } from "vitest";
import {
  createMemory,
  getMemories,
  searchMemories,
  deleteMemory,
} from "../../src/services/memory-service.js";

// Runs against the isolated per-file database provisioned by
// tests/setup-env.ts (migrated schema, user 1 + workspace 1 seeded).

function unwrap<T, E>(
  result: { ok: boolean; value?: T; error?: E },
  what: string,
): T {
  expect(result.ok).toBe(true);
  if (!result.ok)
    throw new Error(`${what} failed: ${(result.error as Error)?.message}`);
  return result.value as T;
}

describe("memory-service", () => {
  it("creates a memory and returns it", async () => {
    const memory = unwrap(
      await createMemory(1, "User prefers dark mode", null, null, [
        "preference",
      ]),
      "createMemory",
    );
    expect(memory).toBeDefined();
    expect(memory.content).toBe("User prefers dark mode");
    expect(memory.workspaceId).toBe(1);
  });

  it("lists memories for a workspace", async () => {
    const memories = unwrap(await getMemories(1), "getMemories");
    expect(memories.length).toBeGreaterThanOrEqual(1);
  });

  it("searches memories by content", async () => {
    const results = unwrap(
      await searchMemories(1, "dark mode"),
      "searchMemories",
    );
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].content).toContain("dark mode");
  });

  it("deletes a memory", async () => {
    // Unique token: searchMemories uses OR semantics across tokens, so the
    // delete assertion must search a token that only this row contains.
    const uniq = `todelete${Date.now()}${Math.floor(Math.random() * 1e6)}`;
    const memory = unwrap(
      await createMemory(1, `Temporary memory to delete ${uniq}`),
      "createMemory",
    );
    unwrap(await deleteMemory(memory.id, 1), "deleteMemory");
    const results = unwrap(await searchMemories(1, uniq), "searchMemories");
    expect(results.length).toBe(0);
  });
});
