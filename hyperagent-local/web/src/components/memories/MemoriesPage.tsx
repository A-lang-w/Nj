import { useEffect, useMemo, useRef, useState } from "react";
import FocusTrap from "focus-trap-react";
import { useUiStore } from "@/stores/ui-store";
import { useFavoritesStore } from "@/stores/favorites-store";
import { apiGet, apiPost, apiDelete } from "@/lib/api-client";
import type { Memory } from "@/types/api";
import {
  Brain,
  Plus,
  Search,
  Trash2,
  Pin,
  List,
  LayoutGrid,
  X,
} from "lucide-react";
import { LoadingIndicator } from "@/components/ui/LoadingIndicator";
import { EmptyState } from "@/components/ui/EmptyState";
import { COLORS } from "@/lib/theme-colors";
import { cn } from "@/lib/utils";

type MemoryScope = "all" | "starred" | "personal" | "agent";
type MemoryLayout = "list" | "grid";

export function MemoriesPage() {
  const [memories, setMemories] = useState<Memory[]>([]);
  const [searchTerm, setSearchTerm] = useState("");
  const [scope, setScope] = useState<MemoryScope>("all");
  const [layout, setLayout] = useState<MemoryLayout>("list");
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const activeWorkspaceId = useUiStore((s) => s.activeWorkspaceId);
  const fetchFavorites = useFavoritesStore((s) => s.fetchFavorites);
  const favoriteKeys = useFavoritesStore((s) => s.keys);
  const toggleFavorite = useFavoritesStore((s) => s.toggleFavorite);
  const requestIdRef = useRef(0);

  useEffect(() => {
    void loadMemories();
    void fetchFavorites();
  }, [activeWorkspaceId, fetchFavorites]);

  const loadMemories = async () => {
    const requestId = ++requestIdRef.current;
    setIsLoading(true);
    setLoadError(null);
    setDeleteError(null);
    try {
      const data = await apiGet<Memory[]>("/memories", {
        workspaceId: activeWorkspaceId,
      });
      if (requestIdRef.current !== requestId) return;
      setMemories(data);
    } catch (err) {
      if (requestIdRef.current !== requestId) return;
      setMemories([]);
      setLoadError(
        err instanceof Error ? err.message : "Failed to load memories",
      );
    } finally {
      if (requestIdRef.current === requestId) setIsLoading(false);
    }
  };

  const handleDelete = async (id: number) => {
    try {
      await apiDelete(`/memories/${id}`);
      setDeleteError(null);
      setMemories((m) => m.filter((mem) => mem.id !== id));
      setSelectedIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    } catch (err) {
      // The row stays in the list with its Delete button, so the alert
      // below plus a second press is the full announce-and-retry path.
      setDeleteError(
        err instanceof Error ? err.message : "Failed to delete memory",
      );
    }
  };

  const handleTogglePin = async (id: number) => {
    try {
      await toggleFavorite("memory", id);
    } catch (err) {
      setDeleteError(
        err instanceof Error ? err.message : "Failed to update pin",
      );
    }
  };

  const handleDeleteSelected = async () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    if (!window.confirm(`Delete ${ids.length} selected memories?`)) return;
    setDeleteError(null);
    const failed: number[] = [];
    for (const id of ids) {
      try {
        await apiDelete(`/memories/${id}`);
      } catch {
        failed.push(id);
      }
    }
    setMemories((m) =>
      m.filter((mem) => !ids.includes(mem.id) || failed.includes(mem.id)),
    );
    setSelectedIds(new Set(failed));
    if (failed.length > 0) {
      setDeleteError(`Couldn't delete ${failed.length} memories`);
    } else {
      setSelectMode(false);
    }
  };

  const filtered = useMemo(() => {
    const scoped = memories.filter((m) => {
      if (scope === "starred") return favoriteKeys.has(`memory:${m.id}`);
      if (scope === "personal") return m.agentId == null;
      if (scope === "agent") return m.agentId != null;
      return true;
    });
    const searched = scoped.filter(
      (m) =>
        !searchTerm ||
        m.content.toLowerCase().includes(searchTerm.toLowerCase()),
    );
    return [...searched].sort((a, b) => {
      const ap = favoriteKeys.has(`memory:${a.id}`) ? 1 : 0;
      const bp = favoriteKeys.has(`memory:${b.id}`) ? 1 : 0;
      return bp - ap;
    });
  }, [memories, searchTerm, scope, favoriteKeys]);

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      style={{
        fontFamily:
          'Geist, "Geist Fallback", ui-sans-serif, system-ui, sans-serif',
        backgroundColor: COLORS.bg,
      }}
    >
      {/* Header - matches original: height=105px, px-6 py-4, border-b */}
      <header
        className="border-b px-6 py-4"
        style={{
          borderColor: COLORS.border,
          height: "104px",
          boxSizing: "border-box",
        }}
      >
        <div
          className="flex w-full flex-col gap-4 md:flex-row md:items-center md:justify-between"
          style={{ height: "72px" }}
        >
          <div
            className="flex min-w-0 flex-col"
            style={{ width: "fit-content", flex: "none" }}
          >
            <h1
              style={{
                fontSize: "24px",
                fontWeight: 600,
                fontVariationSettings: "'wght' 600",
                color: COLORS.textPrimary,
                margin: 0,
                lineHeight: "32px",
                fontFamily:
                  'seasonSans, "seasonSans Fallback", ui-sans-serif, system-ui, sans-serif',
                letterSpacing: "-0.01em",
                width: "fit-content",
              }}
            >
              Memories
            </h1>
            <p
              className="text-sm"
              style={{
                color: COLORS.textSecondary,
                marginTop: "0px",
                lineHeight: "20px",
                width: "fit-content",
              }}
            >
              Browse saved context and memories owned by your agents.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <div
              className="inline-flex w-fit items-center justify-center rounded-md"
              style={{
                backgroundColor: "rgba(235, 235, 235, 0.04)",
                padding: "3px",
                height: "44px",
              }}
              role="group"
              aria-label="Memory layout"
            >
              {(
                [
                  { id: "list" as const, label: "List view", Icon: List },
                  { id: "grid" as const, label: "Grid view", Icon: LayoutGrid },
                ] as const
              ).map(({ id, label, Icon }) => (
                <button
                  key={id}
                  type="button"
                  aria-pressed={layout === id}
                  aria-label={label}
                  onClick={() => setLayout(id)}
                  className="inline-flex min-w-[44px] items-center justify-center rounded font-medium text-sm"
                  style={{
                    color:
                      layout === id ? COLORS.textPrimary : COLORS.textSecondary,
                    backgroundColor:
                      layout === id ? "rgb(6, 6, 6)" : "transparent",
                    height: "38px",
                    padding: "0 10px",
                  }}
                >
                  <Icon
                    className="h-4 w-4"
                    style={{ fill: "none", stroke: "currentColor" }}
                  />
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => setShowCreate(true)}
              aria-label="Add memory"
              className="inline-flex shrink-0 items-center justify-center whitespace-nowrap rounded-md font-medium text-sm"
              style={{
                backgroundColor: COLORS.textPrimary,
                color: COLORS.bg,
                padding: "10px 14px",
                minHeight: "44px",
                boxSizing: "border-box",
              }}
            >
              <Plus
                className="mr-1.5 h-4 w-4"
                style={{ fill: "none", stroke: "currentColor" }}
              />{" "}
              Add memory
            </button>
          </div>
        </div>
      </header>

      <div
        className="flex h-[48px] shrink-0 items-center gap-2 border-b px-4"
        style={{ borderColor: COLORS.border }}
      >
        <label htmlFor="memory-scope" className="sr-only">
          Memory scope
        </label>
        <select
          id="memory-scope"
          value={scope}
          onChange={(e) => setScope(e.target.value as MemoryScope)}
          className="rounded-md border px-2 text-sm min-h-[44px]"
          style={{
            borderColor: COLORS.border,
            backgroundColor: COLORS.inputBg,
            color: COLORS.textPrimary,
          }}
        >
          <option value="all">All memories</option>
          <option value="starred">Starred</option>
          <option value="personal">Personal only</option>
          <option value="agent">Agent-linked</option>
        </select>
        <button
          type="button"
          onClick={() => {
            setSelectMode((v) => !v);
            setSelectedIds(new Set());
          }}
          aria-pressed={selectMode}
          className="inline-flex shrink-0 items-center justify-center whitespace-nowrap rounded-md border px-3 text-sm min-h-[44px]"
          style={{
            borderColor: COLORS.border,
            color: selectMode ? COLORS.textPrimary : COLORS.textSecondary,
            backgroundColor: selectMode ? COLORS.activeBg : "transparent",
          }}
        >
          {selectMode ? "Cancel" : "Select"}
        </button>
        {selectMode && selectedIds.size > 0 && (
          <button
            type="button"
            onClick={() => void handleDeleteSelected()}
            className="inline-flex shrink-0 items-center gap-1 rounded-md bg-red-600 px-3 text-sm font-medium text-white min-h-[44px]"
          >
            <Trash2 className="h-3.5 w-3.5" /> Delete ({selectedIds.size})
          </button>
        )}
        <span
          className="ml-auto hidden whitespace-nowrap text-sm md:inline"
          style={{ color: COLORS.textSecondary }}
        >
          {filtered.length} of {memories.length}
        </span>
        <div className="relative hidden w-64 min-w-[10rem] md:block">
          <Search
            className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2"
            style={{
              color: COLORS.textSecondary,
              fill: "none",
              stroke: "currentColor",
            }}
          />
          <input
            type="text"
            placeholder="Search memories"
            aria-label="Search memories"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="h-9 min-w-0 w-full rounded-md border py-1 pl-9 pr-3 text-base shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
            style={{
              backgroundColor: COLORS.inputBg,
              color: COLORS.textPrimary,
              borderColor: COLORS.border,
            }}
          />
        </div>
      </div>

      {/* Mobile/fallback search row - matches original at y=157-210, height=53px */}
      <div
        className="flex shrink-0 items-center gap-3 border-b px-4 py-2 @3xl/memories:hidden"
        style={{ borderColor: COLORS.border }}
      >
        <div className="relative min-w-0 flex-1">
          <Search
            className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2"
            style={{
              color: COLORS.textSecondary,
              fill: "none",
              stroke: "currentColor",
            }}
          />
          <input
            type="text"
            placeholder="Search memories"
            aria-label="Search memories"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="h-9 min-w-0 w-full rounded-md border px-3 py-1 text-base shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
            style={{
              backgroundColor: COLORS.inputBg,
              color: COLORS.textPrimary,
              borderColor: COLORS.border,
              fontFamily:
                'Geist, "Geist Fallback", ui-sans-serif, system-ui, sans-serif',
            }}
          />
        </div>
      </div>

      {/* Memory cards list - matches original starting at y=210 */}
      <div className="flex-1 overflow-y-auto">
        {deleteError && (
          <p
            role="alert"
            className="px-6 py-2 text-sm"
            style={{ color: "#f87171" }}
          >
            Couldn&apos;t delete memory: {deleteError}
          </p>
        )}
        {isLoading ? (
          <LoadingIndicator label="Loading memories" />
        ) : loadError && filtered.length === 0 ? (
          <EmptyState
            alert
            icon={Brain}
            title="Couldn't load memories"
            description={loadError}
            action={
              <button
                onClick={loadMemories}
                style={{
                  backgroundColor: COLORS.textPrimary,
                  color: COLORS.bg,
                  padding: "10px 14px",
                  minHeight: "44px",
                }}
                className="inline-flex cursor-pointer items-center justify-center whitespace-nowrap rounded-md font-medium text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
              >
                Retry
              </button>
            }
          />
        ) : filtered.length === 0 ? (
          <EmptyState icon={Brain} title="No memories found" />
        ) : (
          <ul
            role="list"
            className={cn(
              "m-0 list-none p-0",
              layout === "grid" &&
                "grid grid-cols-1 gap-3 p-4 sm:grid-cols-2 lg:grid-cols-3",
            )}
          >
            {filtered.map((memory) => {
              const pinned = favoriteKeys.has(`memory:${memory.id}`);
              const selected = selectedIds.has(memory.id);
              return (
                <li
                  key={memory.id}
                  className={cn(
                    "group relative flex w-full select-none items-start gap-3 text-left transition-colors",
                    layout === "list"
                      ? "border-b px-6 py-3"
                      : "rounded-lg border p-4",
                  )}
                  style={{
                    borderColor: COLORS.cardBorder,
                    backgroundColor:
                      selected && selectMode ? COLORS.activeBg : "transparent",
                  }}
                >
                  {selectMode && (
                    <input
                      type="checkbox"
                      checked={selected}
                      onChange={() => {
                        setSelectedIds((prev) => {
                          const next = new Set(prev);
                          if (next.has(memory.id)) next.delete(memory.id);
                          else next.add(memory.id);
                          return next;
                        });
                      }}
                      aria-label={`Select memory ${memory.id}`}
                      className="mt-1 h-4 w-4 shrink-0"
                    />
                  )}
                  <div className="min-w-0 flex-1">
                    <p
                      className="line-clamp-2 break-words text-sm"
                      style={{ color: COLORS.textPrimary }}
                      title={memory.content}
                    >
                      {memory.content}
                    </p>
                    <div className="mt-2 flex min-w-0 flex-wrap items-center gap-1.5">
                      <span
                        className="truncate text-xs"
                        style={{ color: COLORS.textSecondary }}
                      >
                        {memory.createdAt
                          ? new Date(memory.createdAt).toLocaleString()
                          : "Saved memory"}
                      </span>
                      <span
                        className="rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide"
                        style={{
                          backgroundColor: COLORS.avatarBg,
                          color: COLORS.textSecondary,
                        }}
                      >
                        {memory.agentId == null ? "Personal" : "Agent"}
                      </span>
                    </div>
                  </div>
                  {!selectMode && (
                    <div className="flex shrink-0 items-center gap-1">
                      <button
                        type="button"
                        onClick={() => void handleTogglePin(memory.id)}
                        title={pinned ? "Unpin memory" : "Pin memory"}
                        aria-label={pinned ? "Unpin memory" : "Pin memory"}
                        aria-pressed={pinned}
                        className="flex items-center justify-center rounded-md min-w-[44px] min-h-[44px] p-2.5 transition-colors"
                        style={{
                          color: pinned
                            ? COLORS.textPrimary
                            : COLORS.textSecondary,
                        }}
                      >
                        <Pin
                          className="h-4 w-4"
                          style={{
                            fill: pinned ? "currentColor" : "none",
                            stroke: "currentColor",
                          }}
                        />
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleDelete(memory.id)}
                        aria-label="Delete memory"
                        className="flex cursor-pointer items-center justify-center rounded-md min-w-[44px] min-h-[44px] p-2.5 transition-colors"
                        style={{ color: COLORS.textSecondary }}
                      >
                        <Trash2
                          className="h-4 w-4"
                          style={{ fill: "none", stroke: "currentColor" }}
                        />
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {showCreate && (
        <CreateMemoryDialog
          workspaceId={activeWorkspaceId}
          onClose={() => setShowCreate(false)}
          onCreated={(memory) => {
            setMemories((prev) => [memory, ...prev]);
            setShowCreate(false);
          }}
        />
      )}
    </div>
  );
}

function CreateMemoryDialog({
  workspaceId,
  onClose,
  onCreated,
}: {
  workspaceId: number;
  onClose: () => void;
  onCreated: (memory: Memory) => void;
}) {
  const [content, setContent] = useState("");
  const [tags, setTags] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!content.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const tagList = tags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      const created = await apiPost<Memory>("/memories", {
        workspaceId,
        content: content.trim(),
        tags: tagList,
      });
      onCreated(created);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create memory");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <FocusTrap
      active
      focusTrapOptions={{
        allowOutsideClick: true,
        escapeDeactivates: () => {
          onClose();
          return false;
        },
      }}
    >
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
        onClick={onClose}
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Add memory"
          className="w-full max-w-lg rounded-xl border border-slate-200 bg-white p-6 shadow-2xl dark:border-slate-800 dark:bg-slate-900"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-lg font-semibold text-slate-900 dark:text-white">
              Add memory
            </h2>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close dialog"
              className="rounded-lg p-3 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
          <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
            <div>
              <label
                htmlFor="memory-content"
                className="block text-sm font-medium text-slate-700 dark:text-slate-300"
              >
                Content
              </label>
              <textarea
                id="memory-content"
                required
                rows={5}
                value={content}
                onChange={(e) => setContent(e.target.value)}
                className="mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950 dark:text-white"
                placeholder="Something the agent should remember…"
              />
            </div>
            <div>
              <label
                htmlFor="memory-tags"
                className="block text-sm font-medium text-slate-700 dark:text-slate-300"
              >
                Tags (comma-separated)
              </label>
              <input
                id="memory-tags"
                value={tags}
                onChange={(e) => setTags(e.target.value)}
                className="mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950 dark:text-white"
                placeholder="preference, project"
              />
            </div>
            {error && (
              <p
                role="alert"
                className="text-sm text-red-600 dark:text-red-400"
              >
                {error}
              </p>
            )}
            <div className="flex justify-end gap-3">
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg border border-slate-300 px-4 py-2 text-sm dark:border-slate-700"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={submitting || !content.trim()}
                className="rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-primary-950 disabled:opacity-50"
              >
                {submitting ? "Saving…" : "Save memory"}
              </button>
            </div>
          </form>
        </div>
      </div>
    </FocusTrap>
  );
}
