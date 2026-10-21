import React from "react";
import type { Agent } from "@/types/api";
import { Bot, MoreHorizontal } from "lucide-react";

export const AgentCard = React.memo(function AgentCard({
  agent,
}: {
  agent: Agent;
}) {
  return (
    <div className="group rounded-lg border border-slate-200 bg-white p-4 transition-colors hover:border-primary-300 dark:border-slate-800 dark:bg-slate-900 dark:hover:border-primary-700">
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary-100 text-primary-600 dark:bg-primary-900 dark:text-primary-300">
            <Bot className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <h2
              className="truncate font-medium text-slate-900 dark:text-white"
              title={agent.name}
            >
              {agent.name}
            </h2>
            <p
              className="truncate text-xs text-slate-500 dark:text-slate-400"
              title={agent.model}
            >
              {agent.model}
            </p>
          </div>
        </div>
        <button
          type="button"
          disabled
          title="Actions — coming soon"
          aria-label={`Actions for ${agent.name} — coming soon`}
          className="flex min-w-[44px] min-h-[44px] cursor-not-allowed items-center justify-center rounded p-2.5 text-slate-400 opacity-50"
        >
          <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
      {agent.description && (
        <p className="mt-3 text-sm text-slate-600 dark:text-slate-400 line-clamp-2">
          {agent.description}
        </p>
      )}
    </div>
  );
});
