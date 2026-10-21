import OpenAI from "openai";
import {
  DEFAULT_MAX_TOKENS,
  DEFAULT_TEMPERATURE,
} from "../config/constants.js";
import { config } from "../config.js";
import { logger } from "../lib/logger.js";
import { estimateAndRecordUsage, recordUsage } from "../lib/token-tracker.js";

export const llmClient = new OpenAI({
  apiKey: config.llmApiKey,
  baseURL: config.llmBaseUrl,
});

/**
 * DIV-008: Compatibility wrapper for OpenAI SDK calls against Ghost CLI and
 * other OpenAI-compatible local providers. These providers may return
 * non-standard fields or omit expected ones. This wrapper catches unexpected
 * response shapes, logs warnings for diagnostic purposes, and ensures the
 * caller receives a consistent interface regardless of provider quirks.
 */
function validateStreamChunk(
  chunk: OpenAI.ChatCompletionChunk,
): OpenAI.ChatCompletionChunk {
  // Guard against providers that return malformed chunks (e.g., missing choices array)
  if (!chunk || !chunk.choices || !Array.isArray(chunk.choices)) {
    logger.warn(
      "[llm-compat] Received stream chunk without valid choices array. Provider may be non-conformant.",
      { chunkKeys: Object.keys(chunk ?? {}) },
    );
    // Return a safe empty-shape chunk so downstream iteration does not crash
    return { ...chunk, choices: [] } as OpenAI.ChatCompletionChunk;
  }

  // Warn on non-standard fields that Ghost CLI sometimes injects
  const standardTopLevelKeys = new Set([
    "id",
    "object",
    "created",
    "model",
    "choices",
    "usage",
    "system_fingerprint",
  ]);
  for (const key of Object.keys(chunk)) {
    if (!standardTopLevelKeys.has(key)) {
      logger.warn(
        "[llm-compat] Non-standard top-level field in stream chunk. This may indicate a provider extension or spec divergence.",
        { field: key },
      );
    }
  }

  // Validate choice shape
  for (const choice of chunk.choices) {
    if (!choice.delta && !choice.finish_reason) {
      logger.warn(
        "[llm-compat] Stream choice has neither delta nor finish_reason.",
        { index: choice.index },
      );
    }
  }

  return chunk;
}

export interface StreamCompletionOptions {
  temperature?: number;
  maxTokens?: number;
  /**
   * Authenticated user whose token usage should be attributed. Required for
   * per-account billing counters in the in-process tracker.
   */
  userId: number;
  /**
   * Aborts the upstream request when the downstream consumer disconnects
   * (e.g. the chat client pressed Stop). Without this the server keeps
   * reading the provider and persists text past the stop point.
   */
  signal?: AbortSignal;
  /**
   * Maximum silence between chunks before the stream fails. The SDK request
   * timeout only covers connection setup, so a stalled body would otherwise
   * block forever. Defaults to 60s, matching the SSE stall budget order.
   */
  idleTimeoutMs?: number;
}

const DEFAULT_IDLE_TIMEOUT_MS = 60_000;

/**
 * Releases the provider body after a non-abort stream failure (stall). The
 * abort signal belongs to the consumer, not to this module, so a stall must
 * not fire it — but the open body must not linger either. Not awaited: a
 * stalled upstream may never settle its return.
 */
function releaseUpstreamOnFailure(
  iterator: AsyncIterator<OpenAI.ChatCompletionChunk>,
  err: unknown,
): void {
  if (
    err instanceof Error &&
    err.name !== "AbortError" &&
    typeof iterator.return === "function"
  ) {
    void iterator.return(undefined).catch(() => {});
  }
}

/**
 * Reads one chunk from the provider stream, failing fast when the consumer
 * aborts or when no chunk arrives within the idle budget. The abort listener
 * is scoped to a single read so long replies cannot accumulate listeners.
 */
async function nextChunkWithTimeout(
  iterator: AsyncIterator<OpenAI.ChatCompletionChunk>,
  signal: AbortSignal | undefined,
  idleTimeoutMs: number,
): Promise<IteratorResult<OpenAI.ChatCompletionChunk>> {
  if (signal?.aborted) {
    throw new DOMException("Stream aborted by consumer", "AbortError");
  }
  const next = iterator.next();
  // The race below may settle via timeout/abort while next() is still in
  // flight; a later rejection of that orphan must not surface as an
  // unhandled rejection and crash the process.
  void next.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`LLM stream stalled: no chunk for ${idleTimeoutMs}ms`));
    }, idleTimeoutMs);
  });
  let onAbort: (() => void) | null = null;
  const aborted = new Promise<never>((_, reject) => {
    if (!signal) return;
    onAbort = () =>
      reject(new DOMException("Stream aborted by consumer", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([next, timeout, ...(signal ? [aborted] : [])]);
  } catch (err) {
    releaseUpstreamOnFailure(iterator, err);
    throw err;
  } finally {
    if (timer !== null) clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
  }
}

export type ChatToolDefinition = {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
};

/**
 * Non-streaming completion used for MCP tool rounds. Returns assistant
 * content and/or tool_calls so the caller can execute tools and continue.
 */
export async function completeOnce(
  messages: OpenAI.ChatCompletionMessageParam[],
  model: string,
  options: StreamCompletionOptions & {
    tools?: ChatToolDefinition[];
  },
): Promise<{
  content: string | null;
  toolCalls: Array<{
    id: string;
    name: string;
    arguments: string;
  }>;
  finishReason: string | null;
}> {
  const {
    temperature = DEFAULT_TEMPERATURE,
    maxTokens = DEFAULT_MAX_TOKENS,
    userId,
    signal,
    tools,
  } = options;
  if (signal?.aborted) {
    throw new DOMException("Stream aborted before start", "AbortError");
  }
  try {
    const completion = await llmClient.chat.completions.create(
      {
        model,
        messages,
        temperature,
        max_tokens: maxTokens,
        stream: false,
        ...(tools && tools.length > 0
          ? { tools, tool_choice: "auto" as const }
          : {}),
      },
      { signal },
    );
    const choice = completion.choices[0];
    const message = choice?.message;
    const usage = completion.usage;
    if (
      usage &&
      typeof usage.prompt_tokens === "number" &&
      typeof usage.completion_tokens === "number"
    ) {
      recordUsage(userId, model, usage.prompt_tokens, usage.completion_tokens);
    }
    const toolCalls = (message?.tool_calls ?? [])
      .filter((tc) => tc.type === "function" && tc.function?.name)
      .map((tc) => ({
        id: tc.id,
        name: tc.function!.name,
        arguments: tc.function!.arguments ?? "{}",
      }));
    return {
      content: message?.content ?? null,
      toolCalls,
      finishReason: choice?.finish_reason ?? null,
    };
  } catch (err) {
    const safeMsg =
      err instanceof Error
        ? err.message.replace(/sk-[A-Za-z0-9_-]+/g, "[REDACTED]")
        : "Unknown error";
    logger.error(
      "[llm-compat] Failed to create chat completion. Verify baseURL, apiKey, and model are compatible with your provider.",
      { error: safeMsg },
    );
    throw new Error(safeMsg);
  }
}

export async function* streamCompletion(
  messages: OpenAI.ChatCompletionMessageParam[],
  model: string = config.llmModel,
  options: StreamCompletionOptions,
) {
  const {
    temperature = DEFAULT_TEMPERATURE,
    maxTokens = DEFAULT_MAX_TOKENS,
    userId,
    signal,
    idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
  } = options;
  if (signal?.aborted) {
    throw new DOMException("Stream aborted before start", "AbortError");
  }
  let stream: AsyncIterable<OpenAI.ChatCompletionChunk>;
  try {
    stream = await llmClient.chat.completions.create(
      {
        model,
        messages,
        temperature,
        max_tokens: maxTokens,
        stream: true,
      },
      { signal },
    );
  } catch (err) {
    // DIV-008: Catch connection/auth/format errors from non-standard providers.
    // Provider auth errors echo the presented key (e.g. "Incorrect API key
    // provided: sk-proj-..."): redact the full token, including hyphens and
    // underscores, or the suffix leaks past a [A-Za-z0-9]-only match.
    const safeMsg =
      err instanceof Error
        ? err.message.replace(/sk-[A-Za-z0-9_-]+/g, "[REDACTED]")
        : "Unknown error";
    logger.error(
      "[llm-compat] Failed to create chat completion stream. Verify baseURL, apiKey, and model are compatible with your provider.",
      { error: safeMsg },
    );
    // Rethrow redacted, not the original: this error becomes a StorageError
    // message, is written to the chat SSE `error` frame, and is rendered in
    // the UI. The redacted log line above preserves debuggability.
    throw new Error(safeMsg);
  }

  // DIV-007: Ghost CLI / OpenAI-compatible streaming does not reliably return
  // usage metadata (prompt_tokens, completion_tokens) in stream chunks.
  // When `usage` is present on a chunk (e.g. via stream_options.include_usage),
  // we record it directly. Otherwise we estimate tokens from accumulated
  // character counts (~1 token per 4 characters) when the stream finishes.
  const iterator = stream[Symbol.asyncIterator]();
  let completionChars = 0;
  let usageRecorded = false;
  try {
    while (true) {
      const result = await nextChunkWithTimeout(
        iterator,
        signal,
        idleTimeoutMs,
      );
      if (result.done) break;
      const chunk = validateStreamChunk(result.value);
      const delta = chunk.choices[0]?.delta;
      if (delta?.content) {
        completionChars += delta.content.length;
        yield { type: "content" as const, content: delta.content };
      }
      // Extract real usage metadata when the provider includes it.
      // OpenAI-compatible providers surface this on the final chunk when
      // stream_options.include_usage is set.
      const usage = (
        chunk as {
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        }
      ).usage;
      if (
        usage &&
        typeof usage.prompt_tokens === "number" &&
        typeof usage.completion_tokens === "number"
      ) {
        recordUsage(
          userId,
          model,
          usage.prompt_tokens,
          usage.completion_tokens,
        );
        usageRecorded = true;
      }
      if (chunk.choices[0]?.finish_reason) {
        yield {
          type: "done" as const,
          finishReason: chunk.choices[0].finish_reason,
        };
      }
    }
  } finally {
    // Fall back to character-based estimation when no real usage was provided.
    if (!usageRecorded && completionChars > 0) {
      // Prompt chars are not available at stream level; estimate as equal
      // split so the total reflects observed output length. Providers that
      // include usage make this path unnecessary.
      estimateAndRecordUsage(userId, model, completionChars, completionChars);
    }
    // Release the upstream response body promptly on abort so the provider
    // connection does not linger after the consumer is gone. Not awaited:
    // a stalled upstream may never settle its return, which must not block
    // teardown. Rejections are swallowed like releaseUpstreamOnFailure: a
    // floating reject here would surface as an unhandled rejection.
    if (signal?.aborted && typeof iterator.return === "function") {
      void iterator.return(undefined).catch(() => {});
    }
  }
}
