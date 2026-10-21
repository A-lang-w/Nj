import React, { useMemo } from "react";
import type { Message } from "@/types/api";
import { cn, formatDate } from "@/lib/utils";
import { Bot, User } from "lucide-react";

export const MessageBubble = React.memo(function MessageBubble({
  message,
  isStreaming,
}: {
  message: Message;
  isStreaming?: boolean;
}) {
  const isUser = message.role === "user";
  const isSystem = message.role === "system";
  const formattedDate = useMemo(
    () => formatDate(message.createdAt),
    [message.createdAt],
  );

  if (isSystem) return null;

  return (
    <div className={cn("flex gap-3", isUser ? "flex-row-reverse" : "flex-row")}>
      <span className="sr-only">
        {isUser ? "You said:" : "Assistant said:"}
      </span>
      <div
        aria-hidden="true"
        className={cn(
          "flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full",
          isUser
            ? "bg-primary-600 text-primary-950"
            : "bg-slate-200 text-slate-600 dark:bg-slate-700 dark:text-slate-300",
        )}
      >
        {isUser ? <User className="h-4 w-4" /> : <Bot className="h-4 w-4" />}
      </div>
      <div
        className={cn(
          "max-w-[80%] rounded-2xl px-4 py-3 text-sm leading-relaxed",
          isUser
            ? "bg-primary-600 text-primary-950"
            : "bg-white border border-slate-200 text-slate-900 dark:bg-slate-800 dark:border-slate-700 dark:text-slate-100",
        )}
      >
        <div className="whitespace-pre-wrap break-words">
          {message.content}
          {isStreaming && (
            <span
              aria-hidden="true"
              className="ml-1 inline-block h-4 w-1 animate-pulse bg-current align-middle"
            />
          )}
        </div>
        {!isStreaming && (
          <div
            className={cn(
              "mt-1 text-[10px]",
              // The user bubble is light (primary-600), so its timestamp needs dark
              // text; the assistant bubble is dark, so its timestamp needs light text.
              isUser ? "text-primary-900" : "text-slate-400",
            )}
          >
            {formattedDate}
          </div>
        )}
      </div>
    </div>
  );
});
