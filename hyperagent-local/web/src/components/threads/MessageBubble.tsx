import React, { useMemo } from "react";
import type { Message } from "@/types/api";
import { cn, formatDate } from "@/lib/utils";
import { Bot, User, Wrench } from "lucide-react";

function formatToolCalls(toolCalls: unknown[] | null): string | null {
  if (!toolCalls || toolCalls.length === 0) return null;
  const lines: string[] = [];
  for (const raw of toolCalls) {
    if (raw == null || typeof raw !== "object") continue;
    const call = raw as {
      function?: { name?: string; arguments?: string };
      name?: string;
    };
    const name = call.function?.name ?? call.name ?? "tool";
    const args = call.function?.arguments;
    lines.push(args ? `${name}(${args})` : name);
  }
  return lines.length > 0 ? lines.join("\n") : null;
}

export const MessageBubble = React.memo(function MessageBubble({
  message,
  isStreaming,
}: {
  message: Message;
  isStreaming?: boolean;
}) {
  const isUser = message.role === "user";
  const isSystem = message.role === "system";
  const isTool = message.role === "tool";
  const formattedDate = useMemo(
    () => formatDate(message.createdAt),
    [message.createdAt],
  );
  const toolCallsText = useMemo(
    () => formatToolCalls(message.toolCallsJson),
    [message.toolCallsJson],
  );

  if (isSystem) return null;

  return (
    <div className={cn("flex gap-3", isUser ? "flex-row-reverse" : "flex-row")}>
      <span className="sr-only">
        {isUser ? "You said:" : isTool ? "Tool result:" : "Assistant said:"}
      </span>
      <div
        aria-hidden="true"
        className={cn(
          "flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full",
          isUser
            ? "bg-primary-600 text-primary-950"
            : isTool
              ? "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300"
              : "bg-slate-200 text-slate-600 dark:bg-slate-700 dark:text-slate-300",
        )}
      >
        {isUser ? (
          <User className="h-4 w-4" />
        ) : isTool ? (
          <Wrench className="h-4 w-4" />
        ) : (
          <Bot className="h-4 w-4" />
        )}
      </div>
      <div
        className={cn(
          "max-w-[80%] rounded-2xl px-4 py-3 text-sm leading-relaxed",
          isUser
            ? "bg-primary-600 text-primary-950"
            : isTool
              ? "border border-amber-200 bg-amber-50 text-amber-950 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100"
              : "bg-white border border-slate-200 text-slate-900 dark:bg-slate-800 dark:border-slate-700 dark:text-slate-100",
        )}
      >
        {isTool && (
          <p className="mb-1 text-[10px] font-medium uppercase tracking-wide opacity-70">
            Tool
            {message.toolCallId ? ` · ${message.toolCallId}` : ""}
          </p>
        )}
        <div className="whitespace-pre-wrap break-words">
          {message.content}
          {isStreaming && (
            <span
              aria-hidden="true"
              className="ml-1 inline-block h-4 w-1 animate-pulse bg-current align-middle"
            />
          )}
        </div>
        {toolCallsText && (
          <pre className="mt-2 overflow-x-auto rounded-md bg-black/10 p-2 font-mono text-[11px] dark:bg-black/30">
            {toolCallsText}
          </pre>
        )}
        {!isStreaming && (
          <div
            className={cn(
              "mt-1 text-[10px]",
              // The user bubble is light (primary-600), so its timestamp needs dark
              // text; the assistant bubble is dark, so its timestamp needs light text.
              isUser
                ? "text-primary-900"
                : isTool
                  ? "text-amber-700/80 dark:text-amber-300/70"
                  : "text-slate-400",
            )}
          >
            {formattedDate}
          </div>
        )}
      </div>
    </div>
  );
});
