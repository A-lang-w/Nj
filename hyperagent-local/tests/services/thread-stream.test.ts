import { describe, it, expect, vi, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db/connection.js";
import { messages } from "../../src/db/schema.js";
import {
  addMessage,
  createThread,
  streamAssistantResponse,
} from "../../src/services/thread-service.js";
import { streamCompletion } from "../../src/llm/client.js";

// Mock only the LLM boundary: the service keeps its signature and every
// other import stays real. Each test installs its own stream behavior.
vi.mock("../../src/llm/client.js", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../../src/llm/client.js")>();
  return { ...original, streamCompletion: vi.fn() };
});

const mockedStreamCompletion = vi.mocked(streamCompletion);

function unwrap<T, E>(
  result: { ok: boolean; value?: T; error?: E },
  what: string,
): T {
  expect(result.ok).toBe(true);
  if (!result.ok)
    throw new Error(`${what} failed: ${(result.error as Error)?.message}`);
  return result.value as T;
}

afterEach(() => {
  mockedStreamCompletion.mockReset();
});

describe("streamAssistantResponse failure paths", () => {
  it("persists partial content and reports incomplete when the stream dies mid-way", async () => {
    const thread = unwrap(
      await createThread(1, null, "stream-partial"),
      "createThread",
    );
    unwrap(await addMessage(thread.id, "user", "hi"), "addMessage");

    mockedStreamCompletion.mockImplementation(async function* () {
      yield { type: "content" as const, content: "partial" };
      throw new Error("upstream reset");
    });

    const events: Array<{
      type: string;
      messageId?: number;
      incomplete?: boolean;
    }> = [];
    const result = await streamAssistantResponse(
      thread.id,
      "sys",
      "test-model",
      100,
      async (e) => {
        events.push(e);
      },
    );

    expect(result.ok).toBe(true);
    const done = events.find((e) => e.type === "done");
    expect(done?.incomplete).toBe(true);
    expect(typeof done?.messageId).toBe("number");

    const rows = await db
      .select()
      .from(messages)
      .where(eq(messages.threadId, thread.id));
    expect(
      rows.filter((m) => m.role === "assistant").map((m) => m.content),
    ).toEqual(["partial"]);
  });

  it("returns Err when the stream fails before any content", async () => {
    const thread = unwrap(
      await createThread(1, null, "stream-empty"),
      "createThread",
    );
    unwrap(await addMessage(thread.id, "user", "hi"), "addMessage");

    mockedStreamCompletion.mockImplementation(async function* () {
      throw new Error("upstream reset");
    });

    const result = await streamAssistantResponse(
      thread.id,
      "sys",
      "test-model",
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected Err");
    expect(result.error.tag).toBe("StorageError");
  });

  it("stops consuming and persists partial content when aborted (Stop)", async () => {
    const thread = unwrap(
      await createThread(1, null, "stream-abort"),
      "createThread",
    );
    unwrap(await addMessage(thread.id, "user", "hi"), "addMessage");

    const controller = new AbortController();
    let chunksYielded = 0;
    mockedStreamCompletion.mockImplementation(
      async function* (_msgs, _model, options) {
        void _msgs;
        void _model;
        const signal = options?.signal;
        expect(signal).toBe(controller.signal);
        yield { type: "content" as const, content: "before-stop" };
        chunksYielded++;
        // Hang until the consumer aborts, like a provider that keeps sending.
        await new Promise<void>((resolve) => {
          if (signal?.aborted) {
            resolve();
            return;
          }
          signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        throw new DOMException("Stream aborted by consumer", "AbortError");
      },
    );

    const events: Array<{
      type: string;
      messageId?: number;
      incomplete?: boolean;
    }> = [];
    const resultPromise = streamAssistantResponse(
      thread.id,
      "sys",
      "test-model",
      100,
      async (e) => {
        events.push(e);
        if (e.type === "delta") controller.abort();
      },
      controller.signal,
    );
    const result = await resultPromise;

    expect(result.ok).toBe(true);
    expect(chunksYielded).toBe(1);
    const done = events.find((e) => e.type === "done");
    expect(done?.incomplete).toBe(true);

    const rows = await db
      .select()
      .from(messages)
      .where(eq(messages.threadId, thread.id));
    expect(
      rows.filter((m) => m.role === "assistant").map((m) => m.content),
    ).toEqual(["before-stop"]);
  });

  it("persists complete content without the incomplete flag on clean finish", async () => {
    const thread = unwrap(
      await createThread(1, null, "stream-clean"),
      "createThread",
    );
    unwrap(await addMessage(thread.id, "user", "hi"), "addMessage");

    mockedStreamCompletion.mockImplementation(async function* () {
      yield { type: "content" as const, content: "full-reply" };
      yield { type: "done" as const, finishReason: "stop" };
    });

    const events: Array<{
      type: string;
      messageId?: number;
      incomplete?: boolean;
    }> = [];
    const result = await streamAssistantResponse(
      thread.id,
      "sys",
      "test-model",
      100,
      async (e) => {
        events.push(e);
      },
    );
    expect(result.ok).toBe(true);
    const done = events.find((e) => e.type === "done");
    expect(done?.incomplete).not.toBe(true);

    const rows = await db
      .select()
      .from(messages)
      .where(eq(messages.threadId, thread.id));
    expect(
      rows.filter((m) => m.role === "assistant").map((m) => m.content),
    ).toEqual(["full-reply"]);
  });

  it("forwards agent sampling overrides to the LLM stream", async () => {
    const thread = unwrap(
      await createThread(1, null, "stream-sampling"),
      "createThread",
    );
    unwrap(await addMessage(thread.id, "user", "hi"), "addMessage");

    let seenOptions: { temperature?: number; maxTokens?: number } | undefined;
    mockedStreamCompletion.mockImplementation(
      async function* (_msgs, _model, options) {
        seenOptions = options;
        yield { type: "content" as const, content: "sampled" };
        yield { type: "done" as const, finishReason: "stop" };
      },
    );

    const result = await streamAssistantResponse(
      thread.id,
      "sys",
      "test-model",
      100,
      undefined,
      undefined,
      0,
      { temperature: 0.2, maxTokens: 512 },
    );
    expect(result.ok).toBe(true);
    expect(seenOptions?.temperature).toBe(0.2);
    expect(seenOptions?.maxTokens).toBe(512);
  });
});
