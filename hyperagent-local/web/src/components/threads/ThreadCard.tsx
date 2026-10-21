import React, { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { Thread } from "@/types/api";
import { formatDate } from "@/lib/utils";
import { useThreadsStore } from "@/stores/threads-store";
import { apiPost, apiDelete } from "@/lib/api-client";
import {
  Star,
  MoreHorizontal,
  Bot,
  Archive,
  CheckCircle2,
  Trash2,
  Pencil,
} from "lucide-react";

export const ThreadCard = React.memo(function ThreadCard({
  thread,
}: {
  thread: Thread;
}) {
  const titleId = React.useId();
  const titleText = thread.title || "Untitled thread";
  const updateThread = useThreadsStore((s) => s.updateThread);
  const deleteThread = useThreadsStore((s) => s.deleteThread);
  const [menuOpen, setMenuOpen] = useState(false);
  const [favorited, setFavorited] = useState(false);
  const [busy, setBusy] = useState(false);
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

  const toggleFavorite = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setBusy(true);
    try {
      if (favorited) {
        await apiDelete(`/favorites?targetType=thread&targetId=${thread.id}`);
        setFavorited(false);
      } else {
        await apiPost("/favorites", {
          targetType: "thread",
          targetId: thread.id,
        });
        setFavorited(true);
      }
    } catch {
      // Keep prior state; silent — list still usable.
    } finally {
      setBusy(false);
    }
  };

  const setStatus = async (status: Thread["status"]) => {
    setBusy(true);
    setMenuOpen(false);
    try {
      await updateThread(thread.id, { status });
    } finally {
      setBusy(false);
    }
  };

  const rename = async () => {
    const next = window.prompt("Rename thread", titleText);
    if (next === null) return;
    const trimmed = next.trim();
    if (!trimmed || trimmed === titleText) return;
    setBusy(true);
    setMenuOpen(false);
    try {
      await updateThread(thread.id, { title: trimmed });
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!window.confirm(`Delete thread “${titleText}”? This cannot be undone.`))
      return;
    setBusy(true);
    setMenuOpen(false);
    try {
      await deleteThread(thread.id);
    } finally {
      setBusy(false);
    }
  };

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
          >
            {titleText}
          </h2>
          <span className="flex-shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium capitalize text-amber-700 dark:bg-amber-900/50 dark:text-amber-300">
            {thread.status}
          </span>
        </div>
        <p className="mt-1 truncate text-sm text-slate-500 dark:text-slate-400">
          {formatDate(thread.updatedAt)}
        </p>
      </div>
      <div className="relative z-10 flex flex-shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
        <button
          type="button"
          disabled={busy}
          onClick={(e) => void toggleFavorite(e)}
          title={favorited ? "Unstar thread" : "Star thread"}
          aria-label={favorited ? "Unstar thread" : "Star thread"}
          aria-pressed={favorited}
          className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded p-2.5 text-slate-400 hover:bg-slate-100 hover:text-amber-500 dark:hover:bg-slate-800"
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
            disabled={busy}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setMenuOpen((o) => !o);
            }}
            title="Thread actions"
            aria-label="Thread actions"
            aria-expanded={menuOpen}
            aria-haspopup="menu"
            className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded p-2.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800"
          >
            <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
          </button>
          {menuOpen && (
            <div
              role="menu"
              className="absolute right-0 z-20 mt-1 w-44 rounded-lg border border-slate-200 bg-white py-1 shadow-lg dark:border-slate-700 dark:bg-slate-900"
              onClick={(e) => e.stopPropagation()}
            >
              <button
                type="button"
                role="menuitem"
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-slate-100 dark:hover:bg-slate-800"
                onClick={() => void rename()}
              >
                <Pencil className="h-3.5 w-3.5" /> Rename
              </button>
              <button
                type="button"
                role="menuitem"
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-slate-100 dark:hover:bg-slate-800"
                onClick={() => void setStatus("archived")}
              >
                <Archive className="h-3.5 w-3.5" /> Archive
              </button>
              <button
                type="button"
                role="menuitem"
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-slate-100 dark:hover:bg-slate-800"
                onClick={() => void setStatus("completed")}
              >
                <CheckCircle2 className="h-3.5 w-3.5" /> Complete
              </button>
              {thread.status !== "active" && (
                <button
                  type="button"
                  role="menuitem"
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-slate-100 dark:hover:bg-slate-800"
                  onClick={() => void setStatus("active")}
                >
                  <Bot className="h-3.5 w-3.5" /> Reactivate
                </button>
              )}
              <button
                type="button"
                role="menuitem"
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950"
                onClick={() => void remove()}
              >
                <Trash2 className="h-3.5 w-3.5" /> Delete
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
});
