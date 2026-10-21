import { describe, it, expect, vi, afterEach } from "vitest";

// Mock the OpenAI SDK class so the real streamCompletion runs against a
// scripted provider stream. llmClient is constructed at module import.
const { mockCreate } = vi.hoisted(() => ({ mockCreate: vi.fn() }));
vi.mock("openai", () => ({
  default: vi.fn().mockImplementation(() => ({
    chat: { completions: { create: mockCreate } },
  })),
}));

import { streamCompletion } from "../../src/llm/client.js";

afterEach(() => {
  mockCreate.mockReset();
  vi.restoreAllMocks();
});

function contentChunk(content: string) {
  return { choices: [{ index: 0, delta: { content } }] };
}

function doneChunk() {
  return { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
}

async function collect(
  gen: AsyncGenerator<{
    type: string;
    content?: string;
    finishReason?: string;
  }>,
) {
  const out: Array<{ type: string; content?: string; finishReason?: string }> =
    [];
  for await (const item of gen) out.push(item);
  return out;
}

describe("streamCompletion provider boundary", () => {
  it("skips null chunks from non-conformant providers", async () => {
    mockCreate.mockResolvedValue(
      (async function* () {
        yield null;
        yield contentChunk("hi");
        yield doneChunk();
      })(),
    );

    const items = await collect(
      streamCompletion([], "test-model", { userId: 1 }),
    );
    expect(
      items.filter((i) => i.type === "content").map((i) => i.content),
    ).toEqual(["hi"]);
    expect(items.some((i) => i.type === "done")).toBe(true);
  });

  it("aborts promptly when the signal fires mid-stream", async () => {
    const controller = new AbortController();
    mockCreate.mockResolvedValue(
      (async function* () {
        yield contentChunk("part");
        // Hang forever; the abort race must release the consumer.
        await new Promise(() => {});
        yield contentChunk("never");
      })(),
    );

    const gen = streamCompletion([], "test-model", {
      userId: 1,
      signal: controller.signal,
    });
    const first = await gen.next();
    expect(first.value).toEqual({ type: "content", content: "part" });
    controller.abort();
    await expect(collect(gen)).rejects.toThrow(/aborted/i);
  });

  it("fails stalled streams after the idle timeout", async () => {
    const scripted = (async function* () {
      yield contentChunk("part");
      await new Promise(() => {});
      yield contentChunk("never");
    })();
    let returnCalled = false;
    const originalReturn = scripted.return.bind(scripted);
    scripted.return = (async (...args: []) => {
      returnCalled = true;
      return originalReturn(...args);
    }) as typeof scripted.return;
    mockCreate.mockResolvedValue(scripted);

    const gen = streamCompletion([], "test-model", {
      userId: 1,
      idleTimeoutMs: 20,
    });
    const first = await gen.next();
    expect(first.value).toEqual({ type: "content", content: "part" });
    await expect(collect(gen)).rejects.toThrow(/stalled/);
    // The stalled provider body must be released, not left open.
    expect(returnCalled).toBe(true);
  });

  it("swallows a rejecting upstream return() on abort (no unhandled rejection)", async () => {
    const controller = new AbortController();
    const scripted = (async function* () {
      yield contentChunk("part");
      await new Promise(() => {});
      yield contentChunk("never");
    })();
    // A provider teardown that explodes must not escape as an unhandled
    // rejection from the fire-and-forget release in the abort path.
    scripted.return = (async () => {
      throw new Error("upstream return exploded");
    }) as typeof scripted.return;
    mockCreate.mockResolvedValue(scripted);

    const unhandled: unknown[] = [];
    const onUnhandled = (err: unknown) => {
      unhandled.push(err);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const gen = streamCompletion([], "test-model", {
        userId: 1,
        signal: controller.signal,
      });
      const first = await gen.next();
      expect(first.value).toEqual({ type: "content", content: "part" });
      controller.abort();
      await expect(collect(gen)).rejects.toThrow(/aborted/i);
      // Let any floating rejection surface before asserting silence.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("throws immediately when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      collect(
        streamCompletion([], "test-model", {
          userId: 1,
          signal: controller.signal,
        }),
      ),
    ).rejects.toThrow(/aborted/i);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("redacts the full key, including hyphens, when creation fails", async () => {
    const logged: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation(
      (chunk: Uint8Array | string) => {
        logged.push(typeof chunk === "string" ? chunk : chunk.toString());
        return true;
      },
    );
    // Provider auth errors echo the presented key; a hyphen-blind pattern
    // would redact only up to "sk-proj" and leak the random suffix.
    const keySuffix = "Q".repeat(24);
    mockCreate.mockRejectedValueOnce(
      new Error(`Incorrect API key provided: sk-proj-${keySuffix}`),
    );

    await expect(
      collect(streamCompletion([], "test-model", { userId: 1 })),
    ).rejects.toThrow(/Incorrect API key/);
    expect(logged.join("\n")).toContain("[REDACTED]");
    expect(logged.join("\n")).not.toContain(keySuffix);
    // The rejection itself must also be key-free: it becomes the SSE
    // `error` frame payload via thread-service, not just a log line.
    mockCreate.mockRejectedValueOnce(
      new Error(`Incorrect API key provided: sk-proj-${keySuffix}`),
    );
    const rejection = await collect(
      streamCompletion([], "test-model", { userId: 1 }),
    ).then(
      () => {
        throw new Error("expected streamCompletion to reject");
      },
      (err: unknown) => err,
    );
    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).toContain("[REDACTED]");
    expect((rejection as Error).message).not.toContain(keySuffix);
  });
});
