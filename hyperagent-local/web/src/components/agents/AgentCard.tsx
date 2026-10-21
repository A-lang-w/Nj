import React, { useEffect, useRef, useState } from "react";
import type { Agent } from "@/types/api";
import { useAgentsStore } from "@/stores/agents-store";
import { useFavoritesStore } from "@/stores/favorites-store";
import { AgentForm } from "./AgentForm";
import { Bot, MoreHorizontal, Pencil, Star, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";

export const AgentCard = React.memo(function AgentCard({
  agent,
}: {
  agent: Agent;
}) {
  const deleteAgent = useAgentsStore((s) => s.deleteAgent);
  const favorited = useFavoritesStore((s) => s.keys.has(`agent:${agent.id}`));
  const toggleFavorite = useFavoritesStore((s) => s.toggleFavorite);
  const [menuOpen, setMenuOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [starring, setStarring] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [menuOpen]);

  const handleDelete = async () => {
    if (
      !window.confirm(
        `Delete agent “${agent.name}”? Threads that used it keep their history.`,
      )
    ) {
      return;
    }
    setDeleting(true);
    setError(null);
    try {
      await deleteAgent(agent.id);
      setMenuOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete agent");
    } finally {
      setDeleting(false);
    }
  };

  const handleStar = async () => {
    setStarring(true);
    setError(null);
    try {
      await toggleFavorite("agent", agent.id);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to update favorite",
      );
    } finally {
      setStarring(false);
    }
  };

  return (
    <>
      <div className="group relative rounded-lg border border-slate-200 bg-white p-4 transition-colors hover:border-primary-300 dark:border-slate-800 dark:bg-slate-900 dark:hover:border-primary-700">
        <div className="flex items-start justify-between">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary-100 text-primary-600 dark:bg-primary-900 dark:text-primary-300">
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
          <div className="flex items-center">
            <button
              type="button"
              disabled={starring}
              onClick={() => void handleStar()}
              title={favorited ? "Unstar agent" : "Star agent"}
              aria-label={favorited ? "Unstar agent" : "Star agent"}
              aria-pressed={favorited}
              className={cn(
                "flex min-h-[44px] min-w-[44px] items-center justify-center rounded p-2.5 hover:bg-slate-100 dark:hover:bg-slate-800",
                favorited
                  ? "text-amber-500 opacity-100"
                  : "text-slate-400 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 hover:text-amber-500",
              )}
            >
              <Star
                className="h-4 w-4"
                aria-hidden="true"
                fill={favorited ? "currentColor" : "none"}
              />
            </button>
            <div className="relative" ref={menuRef}>
              <button
                type="button"
                onClick={() => setMenuOpen((o) => !o)}
                aria-expanded={menuOpen}
                aria-haspopup="menu"
                aria-label={`Actions for ${agent.name}`}
                className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded p-2.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
              >
                <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
              </button>
              {menuOpen && (
                <div
                  role="menu"
                  className="absolute right-0 z-10 mt-1 w-40 rounded-lg border border-slate-200 bg-white py-1 shadow-lg dark:border-slate-700 dark:bg-slate-900"
                >
                  <button
                    type="button"
                    role="menuitem"
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800"
                    onClick={() => {
                      setMenuOpen(false);
                      setEditing(true);
                    }}
                  >
                    <Pencil className="h-3.5 w-3.5" /> Edit
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    disabled={deleting}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-red-600 hover:bg-red-50 disabled:opacity-50 dark:text-red-400 dark:hover:bg-red-950"
                    onClick={() => void handleDelete()}
                  >
                    <Trash2 className="h-3.5 w-3.5" />{" "}
                    {deleting ? "Deleting…" : "Delete"}
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
        {agent.description && (
          <p className="mt-3 line-clamp-2 text-sm text-slate-600 dark:text-slate-400">
            {agent.description}
          </p>
        )}
        {error && (
          <p
            role="alert"
            className="mt-2 text-xs text-red-600 dark:text-red-400"
          >
            {error}
          </p>
        )}
      </div>
      {editing && <AgentForm agent={agent} onClose={() => setEditing(false)} />}
    </>
  );
});
