import { describe, it, expect } from "vitest";
import {
  createThread,
  getThreads,
  addMessage,
} from "../../src/services/thread-service.js";

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

describe("thread-service", () => {
  it("creates a thread and returns it", async () => {
    const thread = unwrap(
      await createThread(1, null, "Test Thread"),
      "createThread",
    );
    expect(thread).toBeDefined();
    expect(thread.title).toBe("Test Thread");
    expect(thread.workspaceId).toBe(1);
  });

  it("lists threads for a workspace", async () => {
    const result = unwrap(await getThreads(1), "getThreads");
    expect(result.items).toBeDefined();
    expect(Array.isArray(result.items)).toBe(true);
    expect(result.total).toBeNull();
    expect(result.limit).toBe(50);
    expect(result.offset).toBe(0);
  });

  it("adds a message to a thread", async () => {
    const thread = unwrap(
      await createThread(1, null, "Msg Test"),
      "createThread",
    );
    const msg = unwrap(
      await addMessage(thread.id, "user", "Hello world"),
      "addMessage",
    );
    expect(msg.content).toBe("Hello world");
    expect(msg.role).toBe("user");
    expect(msg.threadId).toBe(thread.id);
  });
});
