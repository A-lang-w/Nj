import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import type { Thread, Message } from "@/types/api";
import { apiGet, apiPost, apiPatch, apiDelete } from "@/lib/api-client";

interface ThreadsResponse {
  items: Thread[];
  total: number;
  limit: number;
  offset: number;
}

interface ThreadsState {
  threads: Thread[];
  activeThread: (Thread & { messages: Message[] }) | null;
  isStreaming: boolean;
  streamingContent: string;
  /** True when the last finished stream ended incomplete (stop/stall), until the next send. */
  streamIncomplete: boolean;
  /** Transport/stream failure text from the last stream, until the next send. */
  streamError: string | null;
  /** @internal Mutable buffer backing streamingContent; avoids O(n^2) concat per token. */
  _streamingBuffer: string[];
  /** @internal Thread the in-flight stream belongs to; guards against cross-thread appends. */
  _streamingThreadId: number | null;
  layoutMode: "list" | "grid" | "board";
  searchTerm: string;
  totalCount: number;
  hasMore: boolean;
  isLoading: boolean;
  isLoadingMore: boolean;
  fetchError: string | null;
  loadMoreError: string | null;
  fetchThreads: (workspaceId?: number) => Promise<void>;
  loadMore: (workspaceId?: number) => Promise<void>;
  fetchThread: (id: number) => Promise<void>;
  createThread: (
    workspaceId: number,
    agentId?: number | null,
    title?: string,
  ) => Promise<Thread>;
  updateThread: (
    id: number,
    updates: Partial<Pick<Thread, "title" | "status" | "agentId">>,
  ) => Promise<Thread>;
  deleteThread: (id: number) => Promise<void>;
  sendMessage: (threadId: number, content: string) => Promise<void>;
  /** Bind a fresh streaming session to a thread without posting (autostart). */
  armStream: (threadId: number) => void;
  appendStreamDelta: (delta: string) => void;
  finalizeStream: (
    messageId?: number,
    incomplete?: boolean,
    error?: string | null,
  ) => void;
  cancelStream: () => void;
  setLayoutMode: (mode: "list" | "grid" | "board") => void;
  setSearchTerm: (term: string) => void;
  /** Drop all account-owned state at a session boundary; keeps UI prefs. */
  resetAccountData: () => void;
}

const PAGE_SIZE = 50;

// Local ids for optimistic assistant rows (server id unknown until
// message.done arrives). Start at -2 so they never collide with the
// live streaming bubble (MIN_SAFE_INTEGER) or a reserved -1 sentinel.
// Decremented so concurrent stopped streams never share React keys.
let nextLocalMessageId = -2;

// Staleness guard for overlapping fetchThread calls (fast navigation).
let fetchThreadRequestId = 0;

// Session generation: resetAccountData bumps it so any request started under
// the previous account cannot write when it resolves late. Same-account
// behavior is unchanged — the generation only moves on reset.
let sessionGeneration = 0;

// List epoch: fetchThreads bumps it at start (and createThread at prepend,
// resetAccountData at reset) so overlapping list readers converge instead
// of interleaving. Without this, a loadMore in flight across a same-account
// refresh appends its stale page onto the new page 0 — gaps, duplicate
// React keys, and a stuck hasMore. Latest writer wins, deterministically.
let listEpoch = 0;

export const useThreadsStore = create<ThreadsState>((set, get) => {
  // PERF-003: Streaming tokens arrive far faster than the display refreshes.
  // Publish the joined buffer at most once per animation frame instead of
  // set()ing a full re-join per token (O(n^2) copies for an n-token reply).
  let flushHandle: number | null = null;
  const cancelFlush = () => {
    if (flushHandle !== null) {
      cancelAnimationFrame(flushHandle);
      flushHandle = null;
    }
  };
  // PERF-003 isolation: this flush MUST only write `streamingContent`. Adding
  // any other field here (e.g. isStreaming, activeThread) would defeat the
  // granular selectors below — useStreamingState uses useShallow on just
  // {isStreaming, streamingContent}, and thread-list subscribers select only
  // `threads`. A wider set() would re-render every list row on each delta.
  // If more streaming fields need co-publishing, split them into a separate
  // micro-store or enable subscribeWithSelector middleware instead.
  const scheduleFlush = () => {
    if (flushHandle !== null) return;
    flushHandle = requestAnimationFrame(() => {
      flushHandle = null;
      set({ streamingContent: get()._streamingBuffer.join("") });
    });
  };

  return {
    threads: [],
    activeThread: null,
    isStreaming: false,
    streamingContent: "",
    streamIncomplete: false,
    streamError: null,
    _streamingBuffer: [],
    _streamingThreadId: null,
    layoutMode: "list",
    searchTerm: "",
    totalCount: 0,
    hasMore: false,
    isLoading: false,
    isLoadingMore: false,
    fetchError: null,
    loadMoreError: null,

    // Callers must pass the signed-in workspace from useUiStore (adopted at
    // login, self-healed on session check). No hardcoded workspace id —
    // omitting it would hit the wrong tenant or 404.
    fetchThreads: async (workspaceId?: number) => {
      if (workspaceId === undefined || workspaceId <= 0) {
        set({
          fetchError: "Workspace required to load threads",
          isLoading: false,
        });
        return;
      }
      const generation = sessionGeneration;
      const epoch = ++listEpoch;
      const isCurrent = () =>
        generation === sessionGeneration && epoch === listEpoch;
      set({ isLoading: true, fetchError: null });
      try {
        const response = await apiGet<ThreadsResponse>("/threads", {
          workspaceId,
          limit: PAGE_SIZE,
          offset: 0,
        });
        // A reset crossed this fetch: the response belongs to the previous
        // account and must not repopulate the cleared list. A newer refresh
        // crossed it (workspace switch, SSE resync): latest call wins, so a
        // late first response must not overwrite the newer page 0.
        if (!isCurrent()) return;
        set({
          threads: response.items,
          totalCount: response.total,
          hasMore: response.items.length < response.total,
        });
      } catch (err) {
        // A failed first load must not masquerade as an empty list — but a
        // failure from a superseded fetch must not paint errors over the
        // newer request's list either.
        if (isCurrent()) {
          set({
            fetchError:
              err instanceof Error ? err.message : "Failed to load threads",
          });
        }
      } finally {
        if (isCurrent()) set({ isLoading: false });
      }
    },

    loadMore: async (workspaceId?: number) => {
      if (workspaceId === undefined || workspaceId <= 0) return;
      const { threads, isLoadingMore, hasMore } = get();
      if (isLoadingMore || !hasMore) return;
      const generation = sessionGeneration;
      const epoch = listEpoch;
      set({ isLoadingMore: true, loadMoreError: null });
      try {
        const offset = threads.length;
        const response = await apiGet<ThreadsResponse>("/threads", {
          workspaceId,
          limit: PAGE_SIZE,
          offset,
        });
        if (generation !== sessionGeneration) return;
        // A refresh or create crossed this page: its offset names rows of the
        // old list, so appending would gap or duplicate. Release the spinner —
        // no newer loadMore can own it (the entry guard blocks concurrency) —
        // and let the next scroll fetch from the current length.
        if (epoch !== listEpoch) {
          set({ isLoadingMore: false });
          return;
        }
        set((s) => ({
          threads: [...s.threads, ...response.items],
          totalCount: response.total,
          hasMore: s.threads.length + response.items.length < response.total,
          isLoadingMore: false,
        }));
      } catch (err) {
        // Stale (pre-reset) failures write nothing: the flag is already false
        // from the reset, and a new-account loadMore may own it now.
        if (generation !== sessionGeneration) return;
        // A refresh crossed this page: release the spinner but report no
        // error — the refresh owns the list now.
        if (epoch !== listEpoch) {
          set({ isLoadingMore: false });
          return;
        }
        set({
          isLoadingMore: false,
          loadMoreError:
            err instanceof Error ? err.message : "Failed to load more threads",
        });
      }
    },

    fetchThread: async (id: number) => {
      const requestId = ++fetchThreadRequestId;
      let thread: Thread & { messages: Message[] };
      try {
        thread = await apiGet<Thread & { messages: Message[] }>(
          `/threads/${id}`,
        );
      } catch (err) {
        // Superseded rejection: a newer fetch owns the outcome, so a slow 404
        // for the previous thread must not throw into the new thread's page
        // (which renders loadError before the active thread). Current
        // failures still throw — the caller owns that error state.
        if (fetchThreadRequestId !== requestId) return;
        throw err;
      }
      // Overlapping navigations resolve in arbitrary order; only the latest
      // fetch may replace the active thread.
      if (fetchThreadRequestId !== requestId) return;
      set({ activeThread: thread });
    },

    createThread: async (
      workspaceId: number,
      agentId?: number | null,
      title?: string,
    ) => {
      const generation = sessionGeneration;
      const thread = await apiPost<Thread>("/threads", {
        workspaceId,
        agentId,
        title,
      });
      // A logout/login that crossed this POST must not prepend the previous
      // account's thread to the new account's list.
      if (generation !== sessionGeneration) return thread;
      // The prepend shifts every offset: invalidate in-flight list readers
      // (bumped here, not at POST start, so a loadMore starting mid-create
      // still resolves against the list it measured until the shift lands).
      listEpoch++;
      set((s) => ({ threads: [thread, ...s.threads] }));
      return thread;
    },

    updateThread: async (id, updates) => {
      const generation = sessionGeneration;
      const updated = await apiPatch<Thread>(`/threads/${id}`, updates);
      if (generation !== sessionGeneration) return updated;
      set((s) => ({
        threads: s.threads.map((t) => (t.id === id ? updated : t)),
        activeThread:
          s.activeThread?.id === id
            ? { ...s.activeThread, ...updated }
            : s.activeThread,
      }));
      return updated;
    },

    deleteThread: async (id) => {
      const generation = sessionGeneration;
      await apiDelete(`/threads/${id}`);
      if (generation !== sessionGeneration) return;
      listEpoch++;
      set((s) => ({
        threads: s.threads.filter((t) => t.id !== id),
        activeThread: s.activeThread?.id === id ? null : s.activeThread,
      }));
    },

    sendMessage: async (threadId: number, content: string) => {
      const generation = sessionGeneration;
      const userMessage = await apiPost<Message>(
        `/threads/${threadId}/messages`,
        { content },
      );
      // The active-thread guard below is not enough across accounts: small
      // thread ids collide, so the new account may legitimately own the same
      // id — and then the previous account's message would append to it.
      if (generation !== sessionGeneration) return;
      cancelFlush();
      set((s) => {
        if (!s.activeThread || s.activeThread.id !== threadId) return s;
        return {
          activeThread: {
            ...s.activeThread,
            messages: [...s.activeThread.messages, userMessage],
          },
          isStreaming: true,
          streamingContent: "",
          streamIncomplete: false,
          streamError: null,
          _streamingBuffer: [],
          _streamingThreadId: threadId,
        };
      });
    },

    appendStreamDelta: (delta: string) => {
      // Drop deltas for a stream that no longer owns the active thread (the
      // user navigated away mid-reply): they must not pollute the new thread.
      const s = get();
      if (s.activeThread === null || s._streamingThreadId !== s.activeThread.id)
        return;
      // Hot path stays O(1): push only; the joined string is published to
      // subscribers at most once per animation frame via scheduleFlush.
      s._streamingBuffer.push(delta);
      scheduleFlush();
    },

    finalizeStream: (
      messageId?: number,
      incomplete = false,
      error: string | null = null,
    ) => {
      // Join the buffer directly: the last published streamingContent may lag
      // behind by up to one frame, and finalize must not drop trailing tokens.
      cancelFlush();
      const { activeThread, _streamingThreadId } = get();
      // A stale finalize (navigation replaced the active thread mid-stream)
      // must not append — but it must still release the orphaned streaming
      // state, otherwise isStreaming sticks and the Stop button never clears.
      // This cannot clobber a live stream: a live stream implies a matching
      // binding, and stale continuations are aborted before they can finalize.
      if (activeThread === null || _streamingThreadId !== activeThread.id) {
        set({
          isStreaming: false,
          streamingContent: "",
          streamIncomplete: false,
          streamError: null,
          _streamingBuffer: [],
          _streamingThreadId: null,
        });
        return;
      }
      const streamingContent = get()._streamingBuffer.join("");
      if (!streamingContent) {
        set({
          isStreaming: false,
          streamingContent: "",
          streamIncomplete: false,
          streamError: error,
          _streamingBuffer: [],
          _streamingThreadId: null,
        });
        return;
      }
      const assistantMessage: Message = {
        id: messageId ?? nextLocalMessageId--,
        threadId: activeThread.id,
        role: "assistant",
        content: streamingContent,
        toolCallsJson: null,
        toolCallId: null,
        tokenCount: null,
        model: null,
        createdAt: new Date().toISOString(),
      };
      set({
        activeThread: {
          ...activeThread,
          messages: [...activeThread.messages, assistantMessage],
        },
        isStreaming: false,
        streamingContent: "",
        streamIncomplete: incomplete,
        streamError: error,
        _streamingBuffer: [],
        _streamingThreadId: null,
      });
    },

    cancelStream: () => {
      // Navigation/unmount abort: drop the in-flight stream without appending.
      cancelFlush();
      set({
        isStreaming: false,
        streamingContent: "",
        streamIncomplete: false,
        streamError: null,
        _streamingBuffer: [],
        _streamingThreadId: null,
      });
    },

    armStream: (threadId: number) => {
      // Bind a fresh streaming session to an already-persisted message: the
      // new-thread flow posts before navigation, so sendMessage's arm (which
      // requires the thread to be active) never fires for the first message.
      cancelFlush();
      set({
        isStreaming: true,
        streamingContent: "",
        streamIncomplete: false,
        streamError: null,
        _streamingBuffer: [],
        _streamingThreadId: threadId,
      });
    },

    setLayoutMode: (mode) => set({ layoutMode: mode }),
    setSearchTerm: (term) => set({ searchTerm: term }),

    resetAccountData: () => {
      // Invalidate every in-flight request: their responses belong to the
      // previous account (fetchThread has its own id; everything else shares
      // the session generation; list readers also share the list epoch).
      fetchThreadRequestId++;
      sessionGeneration++;
      listEpoch++;
      cancelFlush();
      set({
        threads: [],
        activeThread: null,
        isStreaming: false,
        streamingContent: "",
        streamIncomplete: false,
        streamError: null,
        _streamingBuffer: [],
        _streamingThreadId: null,
        totalCount: 0,
        hasMore: false,
        isLoading: false,
        isLoadingMore: false,
        fetchError: null,
        loadMoreError: null,
      });
    },
  };
});

/**
 * Granular selector: subscribes only to activeThread.messages.
 * Components using this hook will NOT re-render when non-message
 * fields of activeThread change (e.g., title, status updates).
 */
export const useActiveThreadMessages = () =>
  useThreadsStore((s) => s.activeThread?.messages ?? []);

/**
 * Granular selector: subscribes to activeThread metadata (everything
 * except messages). Uses useShallow to avoid re-renders when the
 * shallow-equal meta object is structurally unchanged.
 */
export const useActiveThreadMeta = () =>
  useThreadsStore(
    useShallow((s) => {
      if (!s.activeThread) return null;
      const { messages: _messages, ...meta } = s.activeThread;
      return meta;
    }),
  );

/**
 * Granular selector: subscribes only to streaming state.
 * Isolates streaming delta updates from thread list and meta subscribers.
 */
export const useStreamingState = () =>
  useThreadsStore(
    useShallow((s) => ({
      isStreaming: s.isStreaming,
      streamingContent: s.streamingContent,
    })),
  );
