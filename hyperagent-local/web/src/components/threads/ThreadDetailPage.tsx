import { useEffect, useRef, useMemo, useState } from "react";
import { useParams, useNavigate, useLocation } from "react-router-dom";
import { useShallow } from "zustand/react/shallow";
import { useThreadsStore } from "@/stores/threads-store";
import { useStreamingChat } from "@/hooks/use-streaming-chat";
import { useSubmitGuard } from "@/hooks/use-submit-guard";
import { sseClient } from "@/lib/sse-client";
import { MessageBubble } from "./MessageBubble";
import { MessageComposer } from "./MessageComposer";
import { ArrowLeft, Bot, AlertTriangle } from "lucide-react";
import { LoadingIndicator } from "@/components/ui/LoadingIndicator";
import { EmptyState } from "@/components/ui/EmptyState";
import { COLORS } from "@/lib/theme-colors";

export function ThreadDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const threadId = Number(id);
  const activeThread = useThreadsStore((state) => state.activeThread);
  const { isStreaming, streamingContent, streamIncomplete, streamError } =
    useThreadsStore(
      useShallow((state) => ({
        isStreaming: state.isStreaming,
        streamingContent: state.streamingContent,
        streamIncomplete: state.streamIncomplete,
        streamError: state.streamError,
      })),
    );
  const fetchThread = useThreadsStore((state) => state.fetchThread);
  const [loadError, setLoadError] = useState<string | null>(null);
  // The composer clears on submit, so a failed send must keep the text here
  // for Resend — otherwise the draft is silently lost with zero feedback.
  const [sendError, setSendError] = useState<string | null>(null);
  const [failedDraft, setFailedDraft] = useState<string | null>(null);
  const { isSubmitting, runGuarded } = useSubmitGuard();
  const { startStream, stopStream } = useStreamingChat(threadId);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollRafRef = useRef<number | null>(null);

  // PERF-015: Stabilize streaming message object via useMemo to preserve memoization in MessageBubble.
  // Use MIN_SAFE_INTEGER so the live bubble never collides with nextLocalMessageId (-2, -3, …).
  const streamingMessage = useMemo(() => {
    if (!isStreaming || !streamingContent) return null;
    return {
      id: Number.MIN_SAFE_INTEGER,
      threadId,
      role: "assistant" as const,
      content: streamingContent,
      toolCallsJson: null,
      toolCallId: null,
      tokenCount: null,
      model: null,
      createdAt: new Date().toISOString(),
    };
  }, [isStreaming, streamingContent, threadId]);

  useEffect(() => {
    // An unparsable :id must fail loudly: skipping the fetch leaves a cold
    // load spinning forever and a warm nav showing the previous thread
    // under the wrong URL.
    // A thread switch also retires the previous thread's send-failure state:
    // the alert hides the draft text, so a stale Resend would silently post
    // the old thread's message into the new one.
    setSendError(null);
    setFailedDraft(null);
    if (!Number.isInteger(threadId) || threadId <= 0) {
      setLoadError("Thread not found");
      return;
    }
    setLoadError(null);
    fetchThread(threadId).catch((err: unknown) => {
      setLoadError(
        err instanceof Error ? err.message : "Failed to load thread",
      );
    });
  }, [fetchThread, threadId]);

  // Autostart the assistant reply after landing here from /threads/new: the
  // first message is already persisted, but nothing starts the chat request.
  // Gated on the loaded thread (deltas bind to the active thread) and keyed
  // by id so a later new-thread navigation can autostart again.
  const autostartConsumedRef = useRef<number | null>(null);
  useEffect(() => {
    const state = location.state as { autostart?: boolean } | null;
    if (
      state?.autostart === true &&
      autostartConsumedRef.current !== threadId &&
      activeThread?.id === threadId &&
      !isStreaming
    ) {
      autostartConsumedRef.current = threadId;
      navigate(".", { replace: true, state: {} });
      void startStream();
    }
  }, [
    location.state,
    activeThread?.id,
    threadId,
    isStreaming,
    startStream,
    navigate,
  ]);

  // The SSE bus otherwise has no consumers: without these, a server restart
  // or buffer eviction leaves this view silently stale. Never resync while
  // this thread owns the live stream — the streaming buffer owns the view.
  useEffect(() => {
    const resyncIfIdle = (data: unknown) => {
      if ((data as { threadId?: unknown } | null)?.threadId !== threadId)
        return;
      const s = useThreadsStore.getState();
      if (s.isStreaming && s._streamingThreadId === threadId) return;
      fetchThread(threadId).catch(() => {
        // Background resync: a failure keeps the current (possibly stale)
        // view rather than replacing it with an error screen.
      });
    };
    const resyncOnGap = () => {
      const s = useThreadsStore.getState();
      if (s.isStreaming && s._streamingThreadId === threadId) return;
      fetchThread(threadId).catch(() => {});
    };
    const unsubs = [
      sseClient.subscribe("thread.message", resyncIfIdle),
      sseClient.subscribe("message.done", resyncIfIdle),
      sseClient.subscribe("replay.gap", resyncOnGap),
    ];
    return () => {
      for (const unsub of unsubs) unsub();
    };
  }, [threadId, fetchThread]);

  // PERF-016: Use requestAnimationFrame guard and instant scroll during streaming
  useEffect(() => {
    if (scrollRafRef.current !== null) {
      cancelAnimationFrame(scrollRafRef.current);
    }
    scrollRafRef.current = requestAnimationFrame(() => {
      messagesEndRef.current?.scrollIntoView({
        behavior: isStreaming ? "instant" : "smooth",
      });
      scrollRafRef.current = null;
    });
    return () => {
      if (scrollRafRef.current !== null) {
        cancelAnimationFrame(scrollRafRef.current);
        scrollRafRef.current = null;
      }
    };
  }, [activeThread?.messages, streamingContent, isStreaming]);

  const handleSend = (content: string) =>
    runGuarded(async () => {
      if (!activeThread) return;
      setSendError(null);
      setFailedDraft(null);
      try {
        await useThreadsStore.getState().sendMessage(threadId, content);
      } catch (err) {
        setSendError(
          err instanceof Error ? err.message : "Failed to send message",
        );
        setFailedDraft(content);
        return;
      }
      startStream();
    });

  const handleResend = () => {
    if (failedDraft === null || !activeThread) return Promise.resolve();
    return handleSend(failedDraft);
  };

  if (loadError) {
    return (
      <EmptyState
        alert
        icon={AlertTriangle}
        title="Couldn't load this thread"
        description={loadError}
        action={
          <button
            onClick={() => {
              // An unparsable :id can never load: reaffirm the error without
              // a meaningless request (the effect path skips it the same way).
              if (!Number.isInteger(threadId) || threadId <= 0) {
                setLoadError("Thread not found");
                return;
              }
              setLoadError(null);
              fetchThread(threadId).catch((err: unknown) => {
                setLoadError(
                  err instanceof Error ? err.message : "Failed to load thread",
                );
              });
            }}
            className="mt-4 rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-primary-950 hover:bg-primary-700"
          >
            Retry
          </button>
        }
      />
    );
  }

  // Render only the thread the URL names: while a warm navigation's fetch
  // is in flight, the store still holds the previous thread.
  if (!activeThread || activeThread.id !== threadId) {
    return <LoadingIndicator label="Loading thread" />;
  }

  return (
    <div
      className="flex h-full flex-col"
      style={{ backgroundColor: COLORS.bg }}
    >
      {/* Header */}
      <div
        className="flex items-center gap-3 px-6 py-4"
        style={{ borderBottom: `1px solid ${COLORS.border}` }}
      >
        <button
          onClick={() => navigate("/threads")}
          className="min-h-[44px] min-w-[44px] rounded-lg p-2 transition-colors hover:opacity-80"
          style={{ color: COLORS.textSecondary }}
          aria-label="Back to threads list"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <div className="flex items-center gap-2">
          <div
            className="flex h-8 w-8 items-center justify-center rounded-lg"
            style={{
              backgroundColor: COLORS.avatarBg,
              color: COLORS.textPrimary,
            }}
          >
            <Bot className="h-4 w-4" />
          </div>
          <h1
            className="text-lg font-semibold"
            style={{ color: COLORS.textPrimary }}
          >
            {activeThread.title || "Untitled thread"}
          </h1>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        <ol
          aria-label="Conversation messages"
          className="mx-auto max-w-3xl space-y-4 list-none p-0 m-0"
        >
          {activeThread.messages.map((msg) => (
            <li key={msg.id}>
              <MessageBubble message={msg} />
            </li>
          ))}
          {streamingMessage && (
            <li key="streaming" aria-live="polite" aria-atomic="true">
              <MessageBubble message={streamingMessage} isStreaming />
            </li>
          )}
          {!isStreaming && streamIncomplete && !streamError && (
            <li aria-live="polite">
              <p
                className="text-center text-xs"
                style={{ color: COLORS.textSecondary }}
              >
                Reply interrupted — showing partial response.
              </p>
            </li>
          )}
          {!isStreaming && streamError && (
            <li aria-live="polite" className="flex flex-col items-center gap-2">
              <p
                className="text-center text-xs"
                style={{ color: COLORS.errorText }}
              >
                Stream failed: {streamError}
              </p>
              <button
                onClick={() => {
                  void startStream();
                }}
                className="rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-primary-950 hover:bg-primary-700"
              >
                Retry reply
              </button>
            </li>
          )}
        </ol>
        {/* A11Y-SEM-01: div ref moved outside ol to avoid invalid nesting */}
        <div ref={messagesEndRef} />
      </div>

      {/* Composer */}
      <div
        className="px-6 py-4"
        style={{ borderTop: `1px solid ${COLORS.border}` }}
      >
        <div className="mx-auto max-w-3xl">
          {sendError && (
            <div
              role="alert"
              className="mb-3 flex items-center justify-between gap-3 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300"
            >
              <span>Couldn&apos;t send: {sendError}</span>
              <button
                onClick={() => {
                  void handleResend();
                }}
                disabled={failedDraft === null || isSubmitting}
                className="shrink-0 rounded-md bg-red-600 px-3 py-1 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
              >
                Resend
              </button>
            </div>
          )}
          <MessageComposer
            key={threadId}
            onSend={handleSend}
            onStop={stopStream}
            isStreaming={isStreaming}
            threadId={threadId}
            disabled={
              !activeThread || activeThread.id !== threadId || isSubmitting
            }
          />
        </div>
      </div>
    </div>
  );
}
