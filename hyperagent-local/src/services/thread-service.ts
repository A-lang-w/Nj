import { readFile } from "node:fs/promises";
import { eq, desc, and } from "drizzle-orm";
import type OpenAI from "openai";
import {
  DEFAULT_CONTEXT_TOKENS,
  DEFAULT_PAGE_LIMIT,
} from "../config/constants.js";
import { db } from "../db/connection.js";
import {
  threads,
  messages,
  memories,
  skills,
  mcpServers,
  agents,
  files,
} from "../db/schema.js";
import { emitEvent } from "../domain/events.js";
import { logger } from "../lib/logger.js";
import { completeOnce, streamCompletion } from "../llm/client.js";
import {
  safeParseJson,
  skillTriggerPatternsSchema,
  threadMetadataSchema,
} from "../db/validators.js";
import { Ok, Err, StorageError } from "../lib/result.js";
import type { Result } from "../lib/result.js";
import {
  bindingsToOpenAiTools,
  buildMcpToolBindings,
  callStdioMcpTool,
  formatAgentTools,
  probeEnabledMcpServers,
  type McpToolBinding,
} from "./mcp-runtime.js";

const MAX_FILE_INJECT_BYTES = 32_768;
const MAX_FILES_TO_INJECT = 4;
const MAX_MCP_TOOL_ROUNDS = 3;

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

export async function updateThread(
  threadId: number,
  workspaceId: number,
  updates: {
    title?: string;
    status?: "active" | "archived" | "completed";
    agentId?: number | null;
  },
): Promise<Result<typeof threads.$inferSelect, StorageError>> {
  try {
    const patch: Partial<typeof threads.$inferInsert> = {
      updatedAt: new Date(),
    };
    if (updates.title !== undefined) patch.title = updates.title;
    if (updates.status !== undefined) patch.status = updates.status;
    if (updates.agentId !== undefined) patch.agentId = updates.agentId;
    const [updated] = await db
      .update(threads)
      .set(patch)
      .where(
        and(eq(threads.id, threadId), eq(threads.workspaceId, workspaceId)),
      )
      .returning();
    if (!updated) {
      return Err(new StorageError("Thread not found"));
    }
    emitEvent("thread.updated", {
      id: updated.id,
      workspaceId,
      status: updated.status,
      title: updated.title,
    });
    return Ok(updated);
  } catch (err) {
    return Err(
      new StorageError(
        err instanceof Error ? err.message : "Failed to update thread",
      ),
    );
  }
}

export async function deleteThread(
  threadId: number,
  workspaceId: number,
): Promise<Result<{ id: number }, StorageError>> {
  try {
    const [deleted] = await db
      .delete(threads)
      .where(
        and(eq(threads.id, threadId), eq(threads.workspaceId, workspaceId)),
      )
      .returning({ id: threads.id });
    if (!deleted) {
      return Err(new StorageError("Thread not found"));
    }
    emitEvent("thread.deleted", { id: deleted.id, workspaceId });
    return Ok(deleted);
  } catch (err) {
    return Err(
      new StorageError(
        err instanceof Error ? err.message : "Failed to delete thread",
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
/**
 * Builds the system prompt with workspace memories, matching skills,
 * agent tools, thread files, and probed MCP tool catalogs. Keeps agent
 * identity first.
 */
async function buildAugmentedSystemPrompt(
  workspaceId: number,
  threadId: number,
  agentSystemPrompt: string,
  latestUserText: string | null,
  agentToolsJson: unknown,
): Promise<string> {
  const sections: string[] = [agentSystemPrompt];

  const agentToolsSection = formatAgentTools(agentToolsJson);
  if (agentToolsSection) sections.push(agentToolsSection);

  try {
    const memoryRows = await db
      .select({ content: memories.content })
      .from(memories)
      .where(eq(memories.workspaceId, workspaceId))
      .orderBy(desc(memories.createdAt))
      .limit(12);
    if (memoryRows.length > 0) {
      sections.push(
        "## Workspace memories\n" +
          memoryRows.map((m, i) => `${i + 1}. ${m.content}`).join("\n"),
      );
    }
  } catch (err) {
    logger.warn("Failed to load memories for chat context", {
      workspaceId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  try {
    const skillRows = await db
      .select({
        name: skills.name,
        instructions: skills.instructions,
        triggerPatternsJson: skills.triggerPatternsJson,
      })
      .from(skills)
      .where(
        and(
          eq(skills.workspaceId, workspaceId),
          eq(skills.approvalStatus, "approved"),
        ),
      )
      .orderBy(desc(skills.createdAt))
      .limit(50);
    const withPatterns = skillRows.map((skill) => ({
      ...skill,
      patterns: safeParseJson(
        skill.triggerPatternsJson,
        skillTriggerPatternsSchema,
        { table: "skills", column: "trigger_patterns_json" },
        [] as string[],
      ),
    }));
    const triggered = withPatterns.filter((skill) => {
      if (skill.patterns.length === 0 || !latestUserText) return false;
      const hay = latestUserText.toLowerCase();
      return skill.patterns.some((p) => {
        try {
          return new RegExp(p, "i").test(latestUserText);
        } catch {
          return hay.includes(p.toLowerCase());
        }
      });
    });
    const alwaysOn = withPatterns.filter((s) => s.patterns.length === 0);
    // Prefer pattern-matched skills; otherwise a few always-on skills.
    const chosen =
      triggered.length > 0 ? triggered.slice(0, 5) : alwaysOn.slice(0, 3);
    if (chosen.length > 0) {
      sections.push(
        "## Active skills\n" +
          chosen.map((s) => `### ${s.name}\n${s.instructions}`).join("\n\n"),
      );
    }
  } catch (err) {
    logger.warn("Failed to load skills for chat context", {
      workspaceId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  try {
    const threadFiles = await db
      .select({
        id: files.id,
        filename: files.filename,
        mimeType: files.mimeType,
        sizeBytes: files.sizeBytes,
        storagePath: files.storagePath,
      })
      .from(files)
      .where(
        and(eq(files.workspaceId, workspaceId), eq(files.threadId, threadId)),
      )
      .orderBy(desc(files.createdAt))
      .limit(20);
    if (threadFiles.length > 0) {
      const indexLines = threadFiles.map(
        (f) =>
          `- id=${f.id} ${f.filename} (${f.mimeType}, ${f.sizeBytes} bytes)`,
      );
      const textBodies: string[] = [];
      let injected = 0;
      for (const f of threadFiles) {
        if (injected >= MAX_FILES_TO_INJECT) break;
        if (
          !isTextLikeMime(f.mimeType) ||
          f.sizeBytes > MAX_FILE_INJECT_BYTES
        ) {
          continue;
        }
        try {
          const raw = await readFile(f.storagePath, "utf8");
          const clipped = raw.slice(0, MAX_FILE_INJECT_BYTES);
          textBodies.push(
            `### ${f.filename} (id=${f.id})\n\`\`\`\n${clipped}\n\`\`\``,
          );
          injected += 1;
        } catch (err) {
          logger.warn("Failed to read thread attachment for chat context", {
            fileId: f.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      sections.push(
        "## Thread attachments\n" +
          indexLines.join("\n") +
          (textBodies.length > 0
            ? "\n\n### Inline text contents\n" + textBodies.join("\n\n")
            : ""),
      );
    }
  } catch (err) {
    logger.warn("Failed to load thread files for chat context", {
      workspaceId,
      threadId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  try {
    const servers = await db
      .select({
        name: mcpServers.name,
        transportType: mcpServers.transportType,
        configJson: mcpServers.configJson,
      })
      .from(mcpServers)
      .where(
        and(
          eq(mcpServers.workspaceId, workspaceId),
          eq(mcpServers.isEnabled, true),
        ),
      )
      .limit(8);
    if (servers.length > 0) {
      const probes = await probeEnabledMcpServers(servers);
      const lines = probes.map((p) => {
        if (p.ok && p.tools.length > 0) {
          const toolLines = p.tools
            .map((t) =>
              t.description
                ? `  - ${t.name}: ${t.description}`
                : `  - ${t.name}`,
            )
            .join("\n");
          return `- ${p.serverName} (${p.transportType}) tools:\n${toolLines}`;
        }
        if (p.ok) {
          return `- ${p.serverName} (${p.transportType}): connected; no tools advertised`;
        }
        return `- ${p.serverName} (${p.transportType}): unavailable — ${p.error ?? "probe failed"}`;
      });
      sections.push(
        "## MCP servers (local)\n" +
          lines.join("\n") +
          "\nEnabled stdio MCP tools are callable during this chat turn when the model requests them.",
      );
    }
  } catch (err) {
    logger.warn("Failed to load MCP servers for chat context", {
      workspaceId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return sections.join("\n\n");
}

function isTextLikeMime(mimeType: string): boolean {
  const mime = mimeType.toLowerCase();
  return (
    mime.startsWith("text/") ||
    mime === "application/json" ||
    mime === "application/xml" ||
    mime === "application/javascript" ||
    mime.endsWith("+json") ||
    mime.endsWith("+xml")
  );
}

async function loadMcpBindingsForWorkspace(
  workspaceId: number,
): Promise<McpToolBinding[]> {
  const servers = await db
    .select({
      name: mcpServers.name,
      transportType: mcpServers.transportType,
      configJson: mcpServers.configJson,
    })
    .from(mcpServers)
    .where(
      and(
        eq(mcpServers.workspaceId, workspaceId),
        eq(mcpServers.isEnabled, true),
      ),
    )
    .limit(8);
  if (servers.length === 0) return [];
  const probes = await probeEnabledMcpServers(servers);
  return buildMcpToolBindings(probes, servers);
}

/**
 * Runs up to {@link MAX_MCP_TOOL_ROUNDS} non-streaming tool rounds, then
 * returns the message list ready for the final streamed answer.
 */
async function runMcpToolRounds(
  llmMessages: OpenAI.ChatCompletionMessageParam[],
  model: string,
  bindings: McpToolBinding[],
  userId: number,
  abortSignal?: AbortSignal,
  sampling?: { temperature?: number; maxTokens?: number },
): Promise<OpenAI.ChatCompletionMessageParam[]> {
  if (bindings.length === 0) return llmMessages;
  const tools = bindingsToOpenAiTools(bindings);
  const byName = new Map(bindings.map((b) => [b.openaiName, b]));
  const working: OpenAI.ChatCompletionMessageParam[] = [...llmMessages];

  for (let round = 0; round < MAX_MCP_TOOL_ROUNDS; round++) {
    if (abortSignal?.aborted) break;
    const result = await completeOnce(working, model, {
      userId,
      signal: abortSignal,
      tools,
      ...sampling,
    });
    // No tool calls: leave working as-is so the streamed completion produces
    // the user-visible reply (avoids duplicating a non-streamed answer).
    if (result.toolCalls.length === 0) {
      break;
    }
    working.push({
      role: "assistant",
      content: result.content,
      tool_calls: result.toolCalls.map((tc) => ({
        id: tc.id,
        type: "function" as const,
        function: { name: tc.name, arguments: tc.arguments },
      })),
    });
    for (const call of result.toolCalls) {
      const binding = byName.get(call.name);
      let toolText: string;
      if (!binding) {
        toolText = `Unknown tool: ${call.name}`;
      } else {
        let parsedArgs: Record<string, unknown> = {};
        try {
          const raw = JSON.parse(call.arguments || "{}") as unknown;
          if (raw != null && typeof raw === "object" && !Array.isArray(raw)) {
            parsedArgs = raw as Record<string, unknown>;
          }
        } catch {
          parsedArgs = {};
        }
        const invoked = await callStdioMcpTool(
          binding.config,
          binding.toolName,
          parsedArgs,
        );
        toolText = invoked.ok
          ? invoked.text
          : `Tool error (${binding.serverName}/${binding.toolName}): ${invoked.error}`;
      }
      working.push({
        role: "tool",
        tool_call_id: call.id,
        content: toolText,
      });
    }
  }
  return working;
}

async function prepareLlmMessages(
  threadId: number,
  agentSystemPrompt: string,
  maxContextTokens = DEFAULT_CONTEXT_TOKENS,
): Promise<Array<{ role: "user" | "assistant" | "system"; content: string }>> {
  const [thread] = await db
    .select({
      workspaceId: threads.workspaceId,
      agentId: threads.agentId,
    })
    .from(threads)
    .where(eq(threads.id, threadId))
    .limit(1);
  const workspaceId = thread?.workspaceId;

  let agentToolsJson: unknown = [];
  if (thread?.agentId != null && workspaceId != null) {
    try {
      const [agent] = await db
        .select({ toolsJson: agents.toolsJson })
        .from(agents)
        .where(
          and(
            eq(agents.id, thread.agentId),
            eq(agents.workspaceId, workspaceId),
          ),
        )
        .limit(1);
      agentToolsJson = agent?.toolsJson ?? [];
    } catch (err) {
      logger.warn("Failed to load agent tools for chat context", {
        threadId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Fetch messages newest-first so we can greedily fill the budget from the
  // most recent end of the conversation without knowing the total row count.
  const candidates = await db
    .select({ role: messages.role, content: messages.content })
    .from(messages)
    .where(eq(messages.threadId, threadId))
    .orderBy(desc(messages.createdAt))
    .limit(200);

  const latestUserText =
    candidates.find((m) => m.role === "user")?.content ?? null;
  const systemPrompt =
    workspaceId != null
      ? await buildAugmentedSystemPrompt(
          workspaceId,
          threadId,
          agentSystemPrompt,
          latestUserText,
          agentToolsJson,
        )
      : agentSystemPrompt;

  const systemTokens = estimateTokens(systemPrompt);
  let remainingBudget = Math.max(0, maxContextTokens - systemTokens);

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

  selected.reverse();

  return [{ role: "system" as const, content: systemPrompt }, ...selected];
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
 * @param sampling - Optional agent sampling overrides (`temperature`, `maxTokens`).
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
  sampling?: { temperature?: number | null; maxTokens?: number | null },
): Promise<Result<void, StorageError>> {
  try {
    const llmMessages = await prepareLlmMessages(
      threadId,
      agentSystemPrompt,
      maxContextTokens,
    );

    const samplingOpts: { temperature?: number; maxTokens?: number } = {};
    if (
      sampling?.temperature != null &&
      Number.isFinite(sampling.temperature)
    ) {
      samplingOpts.temperature = sampling.temperature;
    }
    if (
      sampling?.maxTokens != null &&
      Number.isInteger(sampling.maxTokens) &&
      sampling.maxTokens > 0
    ) {
      samplingOpts.maxTokens = sampling.maxTokens;
    }

    const [threadRow] = await db
      .select({ workspaceId: threads.workspaceId })
      .from(threads)
      .where(eq(threads.id, threadId))
      .limit(1);
    let messagesForStream: OpenAI.ChatCompletionMessageParam[] = llmMessages;
    if (threadRow?.workspaceId != null) {
      try {
        const bindings = await loadMcpBindingsForWorkspace(
          threadRow.workspaceId,
        );
        if (bindings.length > 0 && !abortSignal?.aborted) {
          messagesForStream = await runMcpToolRounds(
            llmMessages,
            model,
            bindings,
            userId,
            abortSignal,
            samplingOpts,
          );
        }
      } catch (err) {
        logger.warn("MCP tool rounds failed; continuing with plain stream", {
          threadId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    let fullContent = "";
    let completed = false;
    let streamError: unknown = null;
    let firstDeltaEmitted = false;
    try {
      for await (const chunk of streamCompletion(messagesForStream, model, {
        signal: abortSignal,
        userId,
        ...samplingOpts,
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
