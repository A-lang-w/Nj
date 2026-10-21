import { eq, desc } from "drizzle-orm";
import {
  DEFAULT_CONTEXT_TOKENS,
  DEFAULT_PAGE_LIMIT,
} from "../config/constants.js";
import { db } from "../db/connection.js";
import { threads, messages } from "../db/schema.js";
import { emitEvent } from "../domain/events.js";
import { logger } from "../lib/logger.js";
import { streamCompletion } from "../llm/client.js";
import { safeParseJson, threadMetadataSchema } from "../db/validators.js";
import { Ok, Err, StorageError } from "../lib/result.js";
import type { Result } from "../lib/result.js";

/**
 * Creates a new thread within a workspace and emits a creation event.
 *
 * @param workspaceId - The numeric identifier of the workspace that owns the thread.
 * @param agentId - Optional agent identifier to associate with the thread; pass `null` for unassigned threads.
 * @param title - Optional human-readable title; defaults to `'New thread'` when omitted or empty.
 * @returns The newly created thread row as returned by the database, including its generated `id`.
 * @throws Propagates any database error from the underlying insert operation.
 * @emits `thread.created` with `{ id, workspaceId }` after successful insertion.
 */
export async function createThread(
  workspaceId: number,
  agentId: number | null,
  title?: string,
): Promise<Result<typeof threads.$inferSelect, StorageError>> {
  try {
    const [thread] = await db
      .insert(threads)
      .values({
        workspaceId,
        agentId,
        title: title || "New thread",
        status: "active",
      })
      .returning();

    emitEvent("thread.created", { id: thread.id, workspaceId });
    return Ok(thread);
  } catch (err) {
    return Err(
      new StorageError(
        err instanceof Error ? err.message : "Failed to create thread",
      ),
    );
  }
}

/**
 * Retrieves a paginated list of threads for a workspace, ordered by most recently updated.
 *
 * @param workspaceId - The numeric identifier of the workspace whose threads to retrieve.
 * @param limit - Maximum number of threads to return; defaults to `50`.
 * @param offset - Number of threads to skip for pagination; defaults to `0`.
 * @returns An object containing `items` (thread rows with parsed `metadataJson`), `total` count, and the applied `limit` and `offset`.
 * @throws Propagates any database error from the underlying select operations.
 */
export async function getThreads(
  workspaceId: number,
  limit = DEFAULT_PAGE_LIMIT,
  offset = 0,
): Promise<
  Result<
    {
      items: Array<
        typeof threads.$inferSelect & { metadataJson: Record<string, unknown> }
      >;
      total: number | null;
      limit: number;
      offset: number;
    },
    StorageError
  >
> {
  try {
    const rows = await db
      .select()
      .from(threads)
      .where(eq(threads.workspaceId, workspaceId))
      .orderBy(desc(threads.updatedAt))
      .limit(limit)
      .offset(offset);

    // Total count is no longer computed per request. Callers that need a
    // total should maintain their own cache or switch to cursor-based
    // pagination. Returning null signals that the value is intentionally
    // absent rather than zero.
    const total: number | null = null;
    const items = rows.map((row) => ({
      ...row,
      metadataJson: safeParseJson(
        row.metadataJson,
        threadMetadataSchema,
        { table: "threads", column: "metadata_json", rowId: row.id },
        {},
      ),
    }));

    return Ok({ items, total, limit, offset });
  } catch (err) {
    return Err(
      new StorageError(
        err instanceof Error ? err.message : "Failed to retrieve threads",
      ),
    );
  }
}

/**
 * Persists a new message to a thread and emits a message-created event.
 *
 * @param threadId - The numeric identifier of the thread that owns the message.
 * @param role - The conversational role of the message author: `'user'`, `'assistant'`, or `'system'`.
 * @param content - The textual body of the message.
 * @returns The newly inserted message row as returned by the database, including its generated `id`.
 * @throws Propagates any database error from the underlying insert operation.
 * @emits `thread.message` with `{ threadId, messageId, role }` after successful insertion.
 */
export async function addMessage(
  threadId: number,
  role: "user" | "assistant" | "system",
  content: string,
): Promise<Result<typeof messages.$inferSelect, StorageError>> {
  try {
    const [message] = await db
      .insert(messages)
      .values({
        threadId,
        role,
        content,
      })
      .returning();

    emitEvent("thread.message", { threadId, messageId: message.id, role });
    return Ok(message);
  } catch (err) {
    return Err(
      new StorageError(
        err instanceof Error ? err.message : "Failed to add message",
      ),
    );
  }
}

/**
 * Estimates the token count of a text string using a character-based heuristic.
 *
 * Uses `content.length / 4` as an approximation when tiktoken is unavailable.
 * This avoids pulling in a heavy tokenizer dependency while still providing
 * budget-aware truncation that respects the model's context window.
 *
 * @param content - The text to estimate.
 * @returns Estimated token count.
 */
function estimateTokens(content: string): number {
  return Math.ceil(content.length / 4);
}

/**
 * Prepares the LLM message array for a given thread by fetching recent history
 * and prepending the system prompt, truncated to fit within a token budget.
 *
 * Messages are fetched newest-first and accumulated until the remaining budget
 * would be exceeded by the next message. The selected messages are then reversed
 * to restore chronological order before being appended after the system prompt.
 *
 * @param threadId - The numeric identifier of the thread whose history should be loaded.
 * @param agentSystemPrompt - System-level instruction prepended to the LLM context.
 * @param maxTokens - Maximum total tokens (system prompt + history) allowed in the
 *   returned message array; defaults to `8000`. The system prompt's estimated tokens
 *   are reserved first; if it alone exceeds the budget, no history is included.
 * @returns An ordered message array beginning with the system prompt followed by
 *   as many recent historical messages as fit within the remaining token budget.
 */
async function prepareLlmMessages(
  threadId: number,
  agentSystemPrompt: string,
  maxContextTokens = DEFAULT_CONTEXT_TOKENS,
): Promise<Array<{ role: "user" | "assistant" | "system"; content: string }>> {
  const systemTokens = estimateTokens(agentSystemPrompt);
  let remainingBudget = Math.max(0, maxContextTokens - systemTokens);

  // Fetch messages newest-first so we can greedily fill the budget from the
  // most recent end of the conversation without knowing the total row count.
  // A conservative SQL LIMIT bounds the row set returned to the client; the
  // greedy loop below still enforces the exact token budget. Threads whose
  // relevant history exceeds this cap would benefit from a precomputed
  // token_count column and a running-sum query, but the limit prevents
  // unbounded fetches for typical workloads without schema changes.
  const candidates = await db
    .select({ role: messages.role, content: messages.content })
    .from(messages)
    .where(eq(messages.threadId, threadId))
    .orderBy(desc(messages.createdAt))
    .limit(200);

  const selected: Array<{
    role: "user" | "assistant" | "system";
    content: string;
  }> = [];
  for (const row of candidates) {
    const msgTokens = estimateTokens(row.content);
    if (msgTokens > remainingBudget) {
      break;
    }
    remainingBudget -= msgTokens;
    selected.push({
      role: row.role as "user" | "assistant" | "system",
      content: row.content,
    });
  }

  // Reverse to restore chronological order (oldest → newest).
  selected.reverse();

  return [{ role: "system" as const, content: agentSystemPrompt }, ...selected];
}

/**
 * Persists the accumulated stream content as an assistant message and emits the terminal event.
 *
 * @param threadId - The numeric identifier of the thread receiving the assistant reply.
 * @param content - The full textual content accumulated during streaming.
 * @param completed - Whether the stream reached its natural end without interruption.
 * @returns The persisted message row when content is non-empty, otherwise `null`.
 */
async function persistStreamResult(
  threadId: number,
  content: string,
  completed: boolean,
): Promise<Result<typeof messages.$inferSelect | null, StorageError>> {
  if (content.length === 0) {
    return Ok(null);
  }

  const result = await addMessage(threadId, "assistant", content);
  if (!result.ok) {
    return result;
  }
  const message = result.value;
  if (completed) {
    emitEvent("message.done", { threadId, messageId: message.id });
  } else {
    // Generation was interrupted: the event flag is the only incompleteness
    // signal. The persisted row carries no marker (messages has no metadata
    // column). Do not encode it as a content prefix: that would leak into
    // LLM history re-reads, exports, and content equality checks.
    emitEvent("message.done", {
      threadId,
      messageId: message.id,
      incomplete: true,
    });
  }

  return Ok(message);
}

/**
 * Callback invoked for each streaming event so callers can bridge domain events
 * to transport-specific concerns (e.g. SSE writes) without duplicating the
 * streaming loop or persistence logic.
 */
export type StreamAssistantEventHandler = (event: {
  type: "delta" | "done";
  threadId: number;
  content?: string;
  messageId?: number;
  incomplete?: boolean;
}) => void | Promise<void>;

/**
 * Persists the accumulated stream content and emits the terminal done event.
 *
 * The done event fires even when persistence fails so transports can always
 * release their streaming state; callers distinguish the outcome via the
 * returned Result.
 */
async function persistAndNotify(
  threadId: number,
  fullContent: string,
  completed: boolean,
  onEvent?: StreamAssistantEventHandler,
): Promise<Result<typeof messages.$inferSelect | null, StorageError>> {
  const persistResult = await persistStreamResult(
    threadId,
    fullContent,
    completed,
  );
  if (onEvent) {
    await onEvent({
      type: "done",
      threadId,
      messageId: persistResult.ok ? persistResult.value?.id : undefined,
      incomplete: !completed && fullContent.length > 0,
    });
  }
  return persistResult;
}

/**
 * Streams an assistant LLM response into a thread, persisting the completed message and emitting progress events.
 *
 * @param threadId - The numeric identifier of the thread that receives the assistant reply.
 * @param agentSystemPrompt - System-level instruction prepended to the LLM context for this turn.
 * @param model - Model identifier passed to the streaming completion client.
 * @param maxContextTokens - Token budget for system prompt + history sent to the
 *   LLM; defaults to {@link DEFAULT_CONTEXT_TOKENS}. History is truncated
 *   newest-first until the budget is exhausted (already token-aware).
 * @param onEvent - Optional handler invoked for each delta and the terminal done event so callers
 *   can forward progress to a transport (e.g. SSE) without re-implementing streaming semantics.
 * @param abortSignal - Optional signal from the transport: when aborted, the
 *   upstream LLM stream is cancelled and partial content is persisted with
 *   `incomplete: true` instead of reading past the disconnect.
 * @param userId - Authenticated user for per-account token usage attribution.
 * @returns `Ok` when the stream completed (or when partial content was persisted after an
 *   interruption, with `incomplete: true` on the done event); `Err` when persistence fails
 *   or when the stream fails before producing any content.
 * @emits `message.delta` once for the first chunk and `message.done` once the full reply is saved.
 */
export async function streamAssistantResponse(
  threadId: number,
  agentSystemPrompt: string,
  model: string,
  maxContextTokens = DEFAULT_CONTEXT_TOKENS,
  onEvent?: StreamAssistantEventHandler,
  abortSignal?: AbortSignal,
  userId = 0,
): Promise<Result<void, StorageError>> {
  try {
    const llmMessages = await prepareLlmMessages(
      threadId,
      agentSystemPrompt,
      maxContextTokens,
    );

    let fullContent = "";
    let completed = false;
    let streamError: unknown = null;
    let firstDeltaEmitted = false;
    try {
      for await (const chunk of streamCompletion(llmMessages, model, {
        signal: abortSignal,
        userId,
      })) {
        if (chunk.type === "done") {
          completed = true;
          continue;
        }
        if (chunk.type !== "content") {
          continue;
        }
        fullContent += chunk.content;
        // The global bus forwards to every connected socket and retains only
        // the last 100 events: emit a single start-of-reply marker carrying
        // just the thread id, never message text. Per-chunk deltas would
        // evict unrelated events; per-request SSE carries the actual text.
        if (!firstDeltaEmitted) {
          firstDeltaEmitted = true;
          emitEvent("message.delta", { threadId });
        }
        if (onEvent) {
          await onEvent({ type: "delta", threadId, content: chunk.content });
        }
      }
    } catch (error) {
      // Stream terminated abnormally; persist partial content below, then
      // report the failure instead of silently returning success.
      streamError = error;
    }
    const persistResult = await persistAndNotify(
      threadId,
      fullContent,
      completed,
      onEvent,
    );
    if (!persistResult.ok) {
      return persistResult;
    }
    const message = persistResult.value;
    if (streamError !== null) {
      if (fullContent.length === 0) {
        return Err(
          new StorageError(
            `Assistant stream failed before producing content: ${streamError instanceof Error ? streamError.message : String(streamError)}`,
          ),
        );
      }
      logger.warn("Assistant stream interrupted; partial content persisted", {
        threadId,
        messageId: message?.id,
        error:
          streamError instanceof Error
            ? streamError.message
            : String(streamError),
      });
    }
    return Ok(undefined);
  } catch (err) {
    return Err(
      new StorageError(
        err instanceof Error
          ? err.message
          : "Failed to stream assistant response",
      ),
    );
  }
}
