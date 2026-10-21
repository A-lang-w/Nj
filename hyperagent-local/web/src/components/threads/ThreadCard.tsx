import React from "react";
import { Link } from "react-router-dom";
import type { Thread } from "@/types/api";
import { formatDate } from "@/lib/utils";
import { Star, MoreHorizontal, Bot } from "lucide-react";

export const ThreadCard = React.memo(function ThreadCard({
  thread,
}: {
  thread: Thread;
}) {
  const titleId = React.useId();
  const titleText = thread.title || "Untitled thread";
  return (
    <div className="group relative flex items-start gap-3 rounded-lg border border-[var(--border)] bg-[var(--card)] p-4 text-[var(--card-foreground)] transition-colors hover:border-primary-300 hover:bg-primary-50/50 dark:hover:border-primary-700 dark:hover:bg-primary-950/30">
      <Link
        to={`/threads/${thread.id}`}
        className="absolute inset-0 z-0 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
        aria-label={`Open thread: ${titleText}`}
      />
      <div className="relative z-10 flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-primary-100 text-primary-600 dark:bg-primary-900 dark:text-primary-300">
        <Bot className="h-5 w-5" aria-hidden="true" />
      </div>
      <div className="relative z-10 min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <h2
            id={titleId}
            className="truncate font-medium text-slate-900 dark:text-white"
            title={titleText}
            aria-describedby={`${titleId}-tooltip`}
          >
            {titleText}
          </h2>
          <span
            id={`${titleId}-tooltip`}
            role="tooltip"
            className="sr-only pointer-events-none absolute -left-[9999px] top-full mt-1 max-w-xs whitespace-normal rounded bg-slate-900 px-2 py-1 text-xs text-white opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-within:opacity-100 dark:bg-slate-100 dark:text-slate-900"
          >
            {titleText}
          </span>
          {thread.status === "active" && (
            <span className="flex-shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-900/50 dark:text-amber-300">
              Active
            </span>
          )}
        </div>
        <p className="mt-1 truncate text-sm text-slate-500 dark:text-slate-400">
          {formatDate(thread.updatedAt)}
        </p>
      </div>
      <div className="relative z-10 flex flex-shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
        <button
          type="button"
          disabled
          title="Star thread — coming soon"
          aria-label="Star thread — coming soon"
          className="flex min-w-[44px] min-h-[44px] cursor-not-allowed items-center justify-center rounded p-2.5 text-slate-400 opacity-50"
        >
          <Star className="h-4 w-4" aria-hidden="true" />
        </button>
        <button
          type="button"
          disabled
          title="More actions — coming soon"
          aria-label="More actions — coming soon"
          className="flex min-w-[44px] min-h-[44px] cursor-not-allowed items-center justify-center rounded p-2.5 text-slate-400 opacity-50"
        >
          <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
});
