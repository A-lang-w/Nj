import {
  DEFAULT_CONTEXT_TOKENS,
  DEFAULT_MODEL,
  DEFAULT_PAGE_LIMIT,
  MAX_MESSAGE_CONTENT_LENGTH,
  MAX_PAGE_LIMIT,
  MAX_PAGINATION_OFFSET,
  MAX_THREAD_TITLE_LENGTH,
} from "../config/constants.js";
import { Hono } from "hono";
import { eq, desc, and, lt } from "drizzle-orm";
import { db } from "../db/connection.js";
import { threads, messages, agents } from "../db/schema.js";
import { authMiddleware } from "../auth/middleware.js";
import {
  authorizeResourceOwnership,
  resolveRequestWorkspaceId,
} from "../auth/workspace.js";
import {
  createThread,
  getThreads,
  addMessage,
  updateThread,
  deleteThread,
  streamAssistantResponse,
} from "../services/thread-service.js";
import { streamSSE } from "hono/streaming";
import { logger } from "../lib/logger.js";
import { readJsonBody } from "../lib/json-body.js";
import { clampPagination } from "../lib/pagination.js";

export const threadsRouter = new Hono();
threadsRouter.use("/*", authMiddleware);

threadsRouter.get("/", async (c) => {
  // SEC-IDOR: Never trust the client-supplied workspace; scope to one the caller owns.
  const authWorkspaceId = await resolveRequestWorkspaceId(
    c,
    c.req.query("workspaceId"),
  );
  if (authWorkspaceId == null) return c.json({ error: "Not found" }, 404);
  const limit = clampPagination(
    c.req.query("limit"),
    DEFAULT_PAGE_LIMIT,
    MAX_PAGE_LIMIT,
  );
  const offset = clampPagination(
    c.req.query("offset"),
    0,
    MAX_PAGINATION_OFFSET,
  );
  const result = await getThreads(authWorkspaceId, limit, offset);
  if (!result.ok) return c.json({ error: result.error.message }, 500);
  const etag = `"${result.value.items.length}-${result.value.items[0]?.updatedAt?.getTime() ?? 0}"`;
  if (c.req.header("If-None-Match") === etag) return c.body(null, 304);
  c.header("ETag", etag);
  c.header("Cache-Control", "private, max-age=0, must-revalidate");
  return c.json(result.value);
});

threadsRouter.get("/alive", async (c) => {
  // SEC-IDOR: Scope to a workspace the caller owns.
  const authWorkspaceId = await resolveRequestWorkspaceId(
    c,
    c.req.query("workspaceId"),
  );
  if (authWorkspaceId == null) return c.json({ error: "Not found" }, 404);
  const active = await db
    .select()
    .from(threads)
    .where(
      and(
        eq(threads.workspaceId, authWorkspaceId),
        eq(threads.status, "active"),
      ),
    )
    .orderBy(desc(threads.updatedAt))
    .limit(20);
  return c.json(active);
});

threadsRouter.post("/", async (c) => {
  const parsed = await readJsonBody(c);
  if (!parsed.ok) return c.json({ error: parsed.error.message }, 400);
  const body = parsed.value;
  if (
    body.agentId !== undefined &&
    body.agentId !== null &&
    typeof body.agentId !== "number"
  ) {
    return c.json({ error: "agentId must be a number" }, 400);
  }
  if (body.title !== undefined && typeof body.title !== "string") {
    return c.json({ error: "title must be a string" }, 400);
  }
  if (
    typeof body.title === "string" &&
    body.title.length > MAX_THREAD_TITLE_LENGTH
  ) {
    return c.json(
      { error: `title must be at most ${MAX_THREAD_TITLE_LENGTH} characters` },
      400,
    );
  }
  // SEC-IDOR: Refuse to create threads in workspaces the caller does not own.
  // Omitted workspaceId resolves to the caller's personal workspace — never
  // hardcoded id 1 (breaks every account whose personal ws is not row 1).
  const authWorkspaceId = await resolveRequestWorkspaceId(
    c,
    typeof body.workspaceId === "number" ? body.workspaceId : null,
  );
  if (authWorkspaceId == null) return c.json({ error: "Not found" }, 404);
  const agentId: number | null =
    typeof body.agentId === "number" ? body.agentId : null;
  if (agentId !== null) {
    // SEC-IDOR: the bound agent must live in the same workspace — otherwise
    // a caller could attach another workspace's private agent and have its
    // system prompt sent to the model at chat time.
    const agentWorkspaceId = await authorizeResourceOwnership(
      agents,
      agents.id,
      agents.workspaceId,
      agentId,
      c,
    );
    if (agentWorkspaceId === null || agentWorkspaceId !== authWorkspaceId) {
      return c.json({ error: "Not found" }, 404);
    }
  }
  const result = await createThread(authWorkspaceId, agentId, body.title);
  if (!result.ok) return c.json({ error: result.error.message }, 500);
  return c.json(result.value, 201);
});

threadsRouter.get("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  // SEC-IDOR: Resolve caller's authorized workspace via shared helper.
  const authWorkspaceId = await authorizeResourceOwnership(
    threads,
    threads.id,
    threads.workspaceId,
    id,
    c,
  );
  if (authWorkspaceId == null) return c.json({ error: "Not found" }, 404);
  const [thread] = await db
    .select()
    .from(threads)
    .where(and(eq(threads.id, id), eq(threads.workspaceId, authWorkspaceId)));
  if (!thread) return c.json({ error: "Not found" }, 404);
  const limit = clampPagination(
    c.req.query("limit"),
    DEFAULT_PAGE_LIMIT,
    MAX_PAGE_LIMIT,
  );
  const beforeRaw = c.req.query("before");
  let beforeCursor: number | undefined;
  if (beforeRaw !== undefined && beforeRaw !== "") {
    const n = Number(beforeRaw);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
      return c.json({ error: "before must be a positive integer" }, 400);
    }
    beforeCursor = n;
  }
  const msgs = await db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.threadId, id),
        ...(beforeCursor !== undefined ? [lt(messages.id, beforeCursor)] : []),
      ),
    )
    .orderBy(desc(messages.id))
    .limit(limit);
  // The query pages newest-first for cursor pagination, but consumers render
  // top-to-bottom and append live messages at the end; return chronological.
  return c.json({ ...thread, messages: msgs.reverse() });
});

threadsRouter.patch("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const authWorkspaceId = await authorizeResourceOwnership(
    threads,
    threads.id,
    threads.workspaceId,
    id,
    c,
  );
  if (authWorkspaceId == null) return c.json({ error: "Not found" }, 404);
  const parsed = await readJsonBody(c);
  if (!parsed.ok) return c.json({ error: parsed.error.message }, 400);
  const body = parsed.value;
  const updates: {
    title?: string;
    status?: "active" | "archived" | "completed";
    agentId?: number | null;
  } = {};
  if (body.title !== undefined) {
    if (typeof body.title !== "string") {
      return c.json({ error: "title must be a string" }, 400);
    }
    if (body.title.length > MAX_THREAD_TITLE_LENGTH) {
      return c.json(
        {
          error: `title must be at most ${MAX_THREAD_TITLE_LENGTH} characters`,
        },
        400,
      );
    }
    updates.title = body.title.trim() || "Untitled";
  }
  if (body.status !== undefined) {
    if (
      body.status !== "active" &&
      body.status !== "archived" &&
      body.status !== "completed"
    ) {
      return c.json(
        { error: "status must be active, archived, or completed" },
        400,
      );
    }
    updates.status = body.status;
  }
  if (body.agentId !== undefined) {
    if (body.agentId !== null && typeof body.agentId !== "number") {
      return c.json({ error: "agentId must be a number or null" }, 400);
    }
    if (typeof body.agentId === "number") {
      const agentWorkspaceId = await authorizeResourceOwnership(
        agents,
        agents.id,
        agents.workspaceId,
        body.agentId,
        c,
      );
      if (agentWorkspaceId === null || agentWorkspaceId !== authWorkspaceId) {
        return c.json({ error: "Not found" }, 404);
      }
    }
    updates.agentId = body.agentId;
  }
  if (Object.keys(updates).length === 0) {
    return c.json({ error: "No updates provided" }, 400);
  }
  const result = await updateThread(id, authWorkspaceId, updates);
  if (!result.ok) {
    const status = result.error.message === "Thread not found" ? 404 : 500;
    return c.json({ error: result.error.message }, status);
  }
  return c.json(result.value);
});

threadsRouter.delete("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const authWorkspaceId = await authorizeResourceOwnership(
    threads,
    threads.id,
    threads.workspaceId,
    id,
    c,
  );
  if (authWorkspaceId == null) return c.json({ error: "Not found" }, 404);
  const result = await deleteThread(id, authWorkspaceId);
  if (!result.ok) {
    const status = result.error.message === "Thread not found" ? 404 : 500;
    return c.json({ error: result.error.message }, status);
  }
  return c.json({ success: true });
});

threadsRouter.post("/:id/messages", async (c) => {
  const threadId = Number(c.req.param("id"));
  // SEC-IDOR: Resolve caller's authorized workspace via shared helper.
  const authWorkspaceId = await authorizeResourceOwnership(
    threads,
    threads.id,
    threads.workspaceId,
    threadId,
    c,
  );
  if (authWorkspaceId == null) return c.json({ error: "Not found" }, 404);
  const parsed = await readJsonBody(c);
  if (!parsed.ok) return c.json({ error: parsed.error.message }, 400);
  const body = parsed.value;
  if (typeof body.content !== "string" || body.content.trim() === "") {
    return c.json({ error: "content must be a non-empty string" }, 400);
  }
  if (body.content.length > MAX_MESSAGE_CONTENT_LENGTH) {
    return c.json(
      {
        error: `content must be at most ${MAX_MESSAGE_CONTENT_LENGTH} characters`,
      },
      400,
    );
  }
  const result = await addMessage(threadId, "user", body.content);
  if (!result.ok) return c.json({ error: result.error.message }, 500);
  return c.json(result.value, 201);
});

threadsRouter.post("/:id/chat", (c) => {
  const threadId = Number(c.req.param("id"));
  return streamSSE(c, async (stream) => {
    try {
      // SEC-IDOR: Resolve caller's authorized workspace via shared helper.
      const authWorkspaceId = await authorizeResourceOwnership(
        threads,
        threads.id,
        threads.workspaceId,
        threadId,
        c,
      );
      if (authWorkspaceId == null) {
        await stream.writeSSE({
          event: "error",
          data: JSON.stringify({ error: "Thread not found" }),
        });
        return;
      }
      // Combined thread + agent lookup in a single round trip via LEFT JOIN.
      const [row] = await db
        .select({
          id: threads.id,
          title: threads.title,
          status: threads.status,
          workspaceId: threads.workspaceId,
          agentId: threads.agentId,
          createdAt: threads.createdAt,
          updatedAt: threads.updatedAt,
          agentSystemPrompt: agents.systemPrompt,
          agentModel: agents.model,
        })
        .from(threads)
        // SEC-IDOR: scope the agent side to this workspace so a thread bound
        // before the create-time check (or bound by hand) cannot leak a
        // foreign agent's system prompt — the join misses and the default
        // prompt applies instead.
        .leftJoin(
          agents,
          and(
            eq(threads.agentId, agents.id),
            eq(agents.workspaceId, authWorkspaceId),
          ),
        )
        .where(
          and(
            eq(threads.id, threadId),
            eq(threads.workspaceId, authWorkspaceId),
          ),
        )
        .limit(1);
      if (!row) {
        await stream.writeSSE({
          event: "error",
          data: JSON.stringify({ error: "Thread not found" }),
        });
        return;
      }
      const systemPrompt =
        row.agentSystemPrompt ?? "You are a helpful assistant.";
      const model = row.agentModel ?? DEFAULT_MODEL;
      // Delegate streaming, persistence, and partial-content recovery to the
      // shared service so the route only bridges domain events to SSE writes.
      // Abort the upstream LLM stream when the client disconnects (Stop):
      // otherwise the server keeps reading the provider and persists text
      // past the stop point.
      const abortController = new AbortController();
      stream.onAbort(() => abortController.abort());
      const auth = c.get("auth");
      const streamResult = await streamAssistantResponse(
        threadId,
        systemPrompt,
        model,
        DEFAULT_CONTEXT_TOKENS,
        async (event) => {
          if (stream.aborted) return;
          if (event.type === "delta" && event.content != null) {
            await stream.writeSSE({
              event: "message.delta",
              data: JSON.stringify({ content: event.content }),
            });
          } else if (event.type === "done") {
            await stream.writeSSE({
              event: "message.done",
              data: JSON.stringify({
                threadId,
                messageId: event.messageId,
                incomplete: event.incomplete === true,
              }),
            });
          }
        },
        abortController.signal,
        auth.userId,
      );
      if (!streamResult.ok && !stream.aborted) {
        logger.error("Chat stream failed", {
          threadId,
          error: streamResult.error,
        });
        // Surface the service's own failure reason: Err covers upstream
        // stalls and empty streams as well as storage failures, and a local
        // single-user client should see which one occurred. Provider secrets
        // are redacted at the llm boundary before they can reach this text.
        await stream.writeSSE({
          event: "error",
          data: JSON.stringify({ error: streamResult.error.message }),
        });
      }
    } catch (err) {
      if (!stream.aborted) {
        logger.error("Chat stream error", { threadId, error: err });
        await stream.writeSSE({
          event: "error",
          data: JSON.stringify({ error: "An internal error occurred" }),
        });
      }
    }
  });
});
