import { useCallback, useEffect, useRef } from "react";
import { streamApiPost } from "@/lib/api-client";
import { useThreadsStore } from "@/stores/threads-store";

export function useStreamingChat(threadId: number) {
  const abortRef = useRef<AbortController | null>(null);
  const threadIdRef = useRef(threadId);
  const appendStreamDelta = useThreadsStore((s) => s.appendStreamDelta);
  const finalizeStream = useThreadsStore((s) => s.finalizeStream);
  const armStream = useThreadsStore((s) => s.armStream);
  const isStreaming = useThreadsStore((s) => s.isStreaming);

  useEffect(() => {
    threadIdRef.current = threadId;
  }, [threadId]);

  // Leaving the thread aborts the in-flight request and drops its buffer.
  // Abort is deferred one macrotask so React StrictMode's remount (same
  // threadId) can keep an autostarted stream: the remounted effect runs
  // before the timeout, threadIdRef still matches, and we skip the abort.
  // Real navigation changes threadIdRef first, so the timeout still fires.
  useEffect(() => {
    const leavingId = threadId;
    return () => {
      const controller = abortRef.current;
      window.setTimeout(() => {
        if (threadIdRef.current === leavingId) return;
        controller?.abort();
        if (abortRef.current === controller) {
          abortRef.current = null;
        }
        const bound = useThreadsStore.getState()._streamingThreadId;
        if (bound === leavingId) {
          useThreadsStore.getState().cancelStream();
        }
      }, 0);
    };
  }, [threadId]);

  const startStream = useCallback(async () => {
    // The send's message POST may have resolved after navigation: if this
    // continuation belongs to a thread that is no longer open, drop it
    // instead of starting a stream that would abort the new thread's own.
    // Only release the store when it still holds this thread's orphaned
    // binding — a newer stream on the current thread must not be cleared.
    if (threadIdRef.current !== threadId) {
      const bound = useThreadsStore.getState()._streamingThreadId;
      if (bound === null || bound === threadId) {
        useThreadsStore.getState().cancelStream();
      }
      return;
    }
    // Bind the streaming session here (not only in sendMessage): autostarted
    // streams post before navigation, so no arm exists when chunks arrive and
    // appendStreamDelta would drop every delta as foreign.
    armStream(threadId);
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    let completedMessageId: number | undefined;
    let streamIncomplete = false;

    try {
      const response = await streamApiPost(
        `/threads/${threadId}/chat`,
        undefined,
        controller.signal,
      );

      if (!response.body) {
        throw new Error("Chat stream failed: no response body");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let currentEvent = "";
      const MAX_SSE_BUFFER_SIZE = 1024 * 1024; // 1 MiB bound to prevent unbounded memory growth

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Flush/discard on overflow: if the buffer exceeds the bound without a
        // newline delimiter, discard it to avoid unbounded memory growth from a
        // malformed or malicious stream that never emits line breaks.
        if (buffer.length > MAX_SSE_BUFFER_SIZE && !buffer.includes("\n")) {
          buffer = "";
          continue;
        }

        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.startsWith("event: ")) {
            currentEvent = line.slice(7).trim();
            continue;
          }
          if (line.startsWith("data: ")) {
            const data = line.slice(6).trim();
            if (!data || data === "{}") continue;
            let parsed: {
              messageId?: unknown;
              content?: unknown;
              error?: unknown;
              incomplete?: unknown;
            };
            try {
              parsed = JSON.parse(data);
            } catch {
              // Skip malformed JSON lines
              continue;
            }
            if (currentEvent === "error") {
              throw new Error(
                typeof parsed.error === "string"
                  ? parsed.error
                  : "Chat stream failed",
              );
            }
            if (
              currentEvent === "message.done" &&
              typeof parsed.messageId === "number"
            ) {
              completedMessageId = parsed.messageId;
              streamIncomplete = parsed.incomplete === true;
            } else if (parsed.content) {
              appendStreamDelta(parsed.content as string);
            }
          }
        }
      }

      finalizeStream(completedMessageId, streamIncomplete);
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        // Transport failure (not a user stop): commit what arrived, flagged,
        // and keep the server's message so the page can show why it stopped.
        finalizeStream(
          completedMessageId,
          true,
          err instanceof Error ? err.message : "Stream failed",
        );
      }
    }
  }, [threadId, appendStreamDelta, finalizeStream, armStream]);

  const stopStream = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    finalizeStream(undefined, true);
  }, [finalizeStream]);

  return { startStream, stopStream, isStreaming };
}
