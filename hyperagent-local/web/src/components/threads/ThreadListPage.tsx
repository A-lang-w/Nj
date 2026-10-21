import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useShallow } from "zustand/react/shallow";
import { useThreadsStore } from "@/stores/threads-store";
import { useUiStore } from "@/stores/ui-store";
import { useFavoritesStore } from "@/stores/favorites-store";
import { sseClient } from "@/lib/sse-client";
import { ThreadCard } from "./ThreadCard";
import {
  Plus,
  Search,
  List,
  LayoutGrid,
  Columns3,
  MessageSquare,
} from "lucide-react";
import { EmptyState } from "@/components/ui/EmptyState";
import { LoadingIndicator } from "@/components/ui/LoadingIndicator";
import { cn } from "@/lib/utils";
import { COLORS } from "@/lib/theme-colors";
import type { Thread } from "@/types/api";

type StatusFilter = "all" | "starred" | Thread["status"];

const buttonSizeVariants = {
  sm: "px-3 py-1.5 text-sm",
  md: "px-4 py-2 text-sm",
  lg: "px-6 py-3 text-base",
} as const;

const BOARD_STATUSES: Thread["status"][] = ["active", "archived", "completed"];

const BOARD_STATUS_LABELS: Record<Thread["status"], string> = {
  active: "Active",
  archived: "Archived",
  completed: "Completed",
};

export function ThreadListPage() {
  const {
    threads,
    layoutMode,
    searchTerm,
    isLoading,
    isLoadingMore,
    hasMore,
    fetchError,
    loadMoreError,
  } = useThreadsStore(
    useShallow((s) => ({
      threads: s.threads,
      layoutMode: s.layoutMode,
      searchTerm: s.searchTerm,
      isLoading: s.isLoading,
      isLoadingMore: s.isLoadingMore,
      hasMore: s.hasMore,
      fetchError: s.fetchError,
      loadMoreError: s.loadMoreError,
    })),
  );
  const fetchThreads = useThreadsStore((s) => s.fetchThreads);
  const loadMore = useThreadsStore((s) => s.loadMore);
  const setLayoutMode = useThreadsStore((s) => s.setLayoutMode);
  const setSearchTerm = useThreadsStore((s) => s.setSearchTerm);
  const fetchFavorites = useFavoritesStore((s) => s.fetchFavorites);
  const favoriteKeys = useFavoritesStore((s) => s.keys);
  const activeWorkspaceId = useUiStore((s) => s.activeWorkspaceId);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");

  useEffect(() => {
    fetchThreads(activeWorkspaceId);
    void fetchFavorites();
  }, [fetchThreads, fetchFavorites, activeWorkspaceId]);

  // Live list: pick up threads created elsewhere and resync after a replay
  // gap (restart/eviction) instead of going silently stale.
  useEffect(() => {
    const refresh = () => {
      fetchThreads(activeWorkspaceId).catch(() => {
        // Background refresh: the page's own error state covers the initial
        // load; a background failure keeps the current list.
      });
    };
    const unsubs = [
      sseClient.subscribe("thread.created", refresh),
      sseClient.subscribe("replay.gap", refresh),
    ];
    return () => {
      for (const unsub of unsubs) unsub();
    };
  }, [fetchThreads, activeWorkspaceId]);

  const filtered = useMemo(
    () =>
      threads.filter((t) => {
        if (statusFilter === "starred") {
          if (!favoriteKeys.has(`thread:${t.id}`)) return false;
        } else if (statusFilter !== "all" && t.status !== statusFilter) {
          return false;
        }
        if (!searchTerm) return true;
        return (
          t.title?.toLowerCase().includes(searchTerm.toLowerCase()) ?? false
        );
      }),
    [threads, searchTerm, statusFilter, favoriteKeys],
  );

  const boardColumns = useMemo(() => {
    const byStatus: Record<Thread["status"], Thread[]> = {
      active: [],
      archived: [],
      completed: [],
    };
    for (const thread of filtered) {
      byStatus[thread.status].push(thread);
    }
    return BOARD_STATUSES.map((status) => ({
      status,
      label: BOARD_STATUS_LABELS[status],
      threads: byStatus[status],
    }));
  }, [filtered]);

  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const loadMoreCallback = useCallback(() => {
    loadMore(activeWorkspaceId);
  }, [loadMore, activeWorkspaceId]);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || !hasMore) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) loadMoreCallback();
      },
      { rootMargin: "200px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
    // layoutMode re-subscribes: list, grid, and board render different
    // sentinel nodes, so without it the observer keeps watching the
    // detached node after a layout switch and infinite scroll silently dies.
  }, [hasMore, loadMoreCallback, layoutMode]);

  const loadMoreFooter = (
    <>
      {hasMore && <div ref={sentinelRef} className="h-1" />}
      {isLoadingMore && (
        <LoadingIndicator label="Loading more threads" className="py-4" />
      )}
      {!isLoadingMore && loadMoreError && (
        <p
          role="alert"
          className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-center text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300"
        >
          {loadMoreError}{" "}
          <button onClick={loadMoreCallback} className="font-medium underline">
            Retry
          </button>
        </p>
      )}
    </>
  );

  return (
    <div
      className="flex h-full flex-col"
      style={{ backgroundColor: COLORS.bg }}
    >
      {/* Header */}
      <div
        className="flex flex-col gap-4 border-b px-6 py-4 md:flex-row md:items-center md:justify-between"
        style={{
          borderColor: COLORS.border,
          height: "104px",
          boxSizing: "border-box",
        }}
      >
        <h1 className="text-xl font-bold" style={{ color: COLORS.textPrimary }}>
          Threads
        </h1>
        <Link
          to="/threads/new"
          className={cn(
            "flex items-center gap-2 rounded-lg bg-primary-600 font-medium text-primary-950 transition-colors hover:bg-primary-700 focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:outline-none",
            buttonSizeVariants.md,
          )}
        >
          <Plus className="h-4 w-4" /> New thread
        </Link>
      </div>

      {/* Toolbar */}
      <div
        className="flex shrink-0 flex-wrap items-center gap-3 border-b px-4 py-2 md:h-[48px] md:flex-nowrap md:px-6"
        style={{ borderColor: COLORS.border }}
      >
        <div className="relative hidden flex-1 max-w-md lg:block">
          <Search
            className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2"
            style={{ color: COLORS.textSecondary }}
          />
          <input
            type="text"
            placeholder="Search by name or topic"
            aria-label="Search threads by name or topic"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full rounded-lg border py-2 pl-9 pr-3 text-sm focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500"
            style={{
              borderColor: COLORS.border,
              backgroundColor: COLORS.inputBg,
              color: COLORS.textPrimary,
            }}
          />
        </div>
        <label htmlFor="thread-status-filter" className="sr-only">
          Filter by status
        </label>
        <select
          id="thread-status-filter"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
          className={cn(
            "rounded-lg border text-sm min-h-[44px]",
            buttonSizeVariants.sm,
          )}
          style={{
            borderColor: COLORS.border,
            backgroundColor: COLORS.inputBg,
            color: COLORS.textPrimary,
          }}
        >
          <option value="all">All statuses</option>
          <option value="starred">Starred</option>
          <option value="active">Active</option>
          <option value="archived">Archived</option>
          <option value="completed">Completed</option>
        </select>
        <div
          className="flex rounded-lg border"
          style={{ borderColor: COLORS.border }}
        >
          {(["list", "grid", "board"] as const).map((mode) => (
            <button
              key={mode}
              aria-label={`${mode.charAt(0).toUpperCase() + mode.slice(1)} view`}
              onClick={() => setLayoutMode(mode)}
              className={cn(
                buttonSizeVariants.sm,
                "min-w-[44px] min-h-[44px] transition-colors first:rounded-l-lg last:rounded-r-lg focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:outline-none",
              )}
              style={{
                backgroundColor:
                  layoutMode === mode ? COLORS.activeBg : "transparent",
                color:
                  layoutMode === mode
                    ? COLORS.textPrimary
                    : COLORS.textSecondary,
              }}
              onMouseEnter={(e) => {
                if (layoutMode !== mode)
                  e.currentTarget.style.backgroundColor = COLORS.hoverBg;
              }}
              onMouseLeave={(e) => {
                if (layoutMode !== mode)
                  e.currentTarget.style.backgroundColor = "transparent";
              }}
            >
              {mode === "list" && <List className="h-4 w-4" />}
              {mode === "grid" && <LayoutGrid className="h-4 w-4" />}
              {mode === "board" && <Columns3 className="h-4 w-4" />}
            </button>
          ))}
        </div>
      </div>

      {/* Mobile search row - full-width input on small screens, hidden at lg+ */}
      <div
        className="flex shrink-0 items-center gap-3 border-b px-4 py-2 lg:hidden"
        style={{ borderColor: COLORS.border }}
      >
        <div className="relative min-w-0 flex-1">
          <Search
            className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2"
            style={{ color: COLORS.textSecondary }}
          />
          <input
            type="text"
            placeholder="Search by name or topic"
            aria-label="Search threads by name or topic"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="h-9 min-w-0 w-full rounded-lg border px-3 py-1 text-sm shadow-xs outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500"
            style={{
              backgroundColor: COLORS.inputBg,
              color: COLORS.textPrimary,
              borderColor: COLORS.border,
            }}
          />
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6">
        {isLoading ? (
          <LoadingIndicator label="Loading threads" className="h-full" />
        ) : fetchError && filtered.length === 0 ? (
          <EmptyState
            alert
            icon={MessageSquare}
            title="Couldn't load threads"
            description={fetchError}
            action={
              <button
                onClick={() => fetchThreads(activeWorkspaceId)}
                className="rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-primary-950 hover:bg-primary-700"
              >
                Retry
              </button>
            }
          />
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={MessageSquare}
            title={searchTerm ? "No matching threads" : "No threads yet"}
            action={
              searchTerm ? undefined : (
                <Link
                  to="/threads/new"
                  className="text-primary-600 hover:underline focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:outline-none rounded"
                >
                  Create your first thread
                </Link>
              )
            }
          />
        ) : layoutMode === "list" ? (
          <div className="space-y-2">
            {filtered.map((thread) => (
              <ThreadCard key={thread.id} thread={thread} />
            ))}
            {loadMoreFooter}
          </div>
        ) : layoutMode === "board" ? (
          <div className="flex min-h-0 gap-4 overflow-x-auto pb-2">
            {boardColumns.map((column) => (
              <div
                key={column.status}
                className="flex w-72 shrink-0 flex-col rounded-lg border"
                style={{
                  borderColor: COLORS.border,
                  backgroundColor: COLORS.inputBg,
                }}
              >
                <div
                  className="flex items-center justify-between border-b px-3 py-2"
                  style={{ borderColor: COLORS.border }}
                >
                  <h2
                    className="text-sm font-medium"
                    style={{ color: COLORS.textPrimary }}
                  >
                    {column.label}
                  </h2>
                  <span
                    className="rounded-full px-2 py-0.5 text-xs"
                    style={{
                      backgroundColor: COLORS.activeBg,
                      color: COLORS.textSecondary,
                    }}
                  >
                    {column.threads.length}
                  </span>
                </div>
                <div className="flex flex-1 flex-col gap-2 p-2">
                  {column.threads.length === 0 ? (
                    <p
                      className="px-2 py-4 text-center text-xs"
                      style={{ color: COLORS.textSecondary }}
                    >
                      No threads
                    </p>
                  ) : (
                    column.threads.map((thread) => (
                      <ThreadCard key={thread.id} thread={thread} />
                    ))
                  )}
                </div>
              </div>
            ))}
            <div className="w-full shrink-0 basis-full">{loadMoreFooter}</div>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {filtered.map((thread) => (
              <ThreadCard key={thread.id} thread={thread} />
            ))}
            <div className="col-span-full">{loadMoreFooter}</div>
          </div>
        )}
      </div>
    </div>
  );
}
