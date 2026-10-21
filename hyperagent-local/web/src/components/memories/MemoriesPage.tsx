import { useEffect, useMemo, useRef, useState } from "react";
import { useUiStore } from "@/stores/ui-store";
import { apiGet, apiDelete } from "@/lib/api-client";
import type { Memory } from "@/types/api";
import {
  Brain,
  Plus,
  Search,
  Trash2,
  Pin,
  List,
  LayoutGrid,
  MoreHorizontal,
} from "lucide-react";
import { LoadingIndicator } from "@/components/ui/LoadingIndicator";
import { EmptyState } from "@/components/ui/EmptyState";
import { COLORS } from "@/lib/theme-colors";

export function MemoriesPage() {
  const [memories, setMemories] = useState<Memory[]>([]);
  const [searchTerm, setSearchTerm] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const activeWorkspaceId = useUiStore((s) => s.activeWorkspaceId);
  const requestIdRef = useRef(0);

  useEffect(() => {
    void loadMemories();
  }, [activeWorkspaceId]);

  const loadMemories = async () => {
    const requestId = ++requestIdRef.current;
    setIsLoading(true);
    setLoadError(null);
    setDeleteError(null);
    try {
      const params: Record<string, string | number> = {
        workspaceId: activeWorkspaceId,
      };
      const data = await apiGet<Memory[]>("/memories", params);
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
    } catch (err) {
      // The row stays in the list with its Delete button, so the alert
      // below plus a second press is the full announce-and-retry path.
      setDeleteError(
        err instanceof Error ? err.message : "Failed to delete memory",
      );
    }
  };

  const filtered = useMemo(
    () =>
      memories.filter(
        (m) =>
          !searchTerm ||
          m.content.toLowerCase().includes(searchTerm.toLowerCase()),
      ),
    [memories, searchTerm],
  );

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
            {/* View toggle button group - matches original at y=37-67 */}
            <div
              className="inline-flex w-fit items-center justify-center rounded-md"
              style={{
                backgroundColor: "rgba(235, 235, 235, 0.04)",
                padding: "3px",
                width: "74px",
                height: "44px",
              }}
            >
              <button
                disabled
                title="List view — coming soon"
                aria-label="List view — coming soon"
                className="inline-flex flex-1 cursor-not-allowed items-center justify-center gap-1.5 whitespace-nowrap rounded font-medium text-sm opacity-50"
                style={{
                  color: COLORS.textPrimary,
                  backgroundColor: "rgb(6, 6, 6)",
                  height: "38px",
                }}
              >
                <span className="flex items-center justify-center">
                  <List
                    className="h-4 w-4"
                    style={{ fill: "none", stroke: "currentColor" }}
                  />
                </span>
              </button>
              <button
                disabled
                title="Grid view — coming soon"
                aria-label="Grid view — coming soon"
                className="inline-flex flex-1 cursor-not-allowed items-center justify-center gap-1.5 whitespace-nowrap rounded font-medium text-sm opacity-50"
                style={{
                  color: COLORS.textSecondary,
                  backgroundColor: "transparent",
                  height: "38px",
                }}
              >
                <span className="flex items-center justify-center">
                  <LayoutGrid
                    className="h-4 w-4"
                    style={{ fill: "none", stroke: "currentColor" }}
                  />
                </span>
              </button>
            </div>
            <button
              disabled
              title="Add memory — coming soon"
              aria-label="Add memory — coming soon"
              className="inline-flex shrink-0 cursor-not-allowed items-center justify-center whitespace-nowrap rounded-md font-medium text-sm opacity-50"
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
            <button
              disabled
              title="More actions — coming soon"
              aria-label="More actions — coming soon"
              className="inline-flex shrink-0 cursor-not-allowed items-center justify-center gap-2 whitespace-nowrap rounded-md font-medium text-sm opacity-50"
              style={{
                color: COLORS.textPrimary,
                minWidth: "44px",
                minHeight: "44px",
              }}
            >
              <MoreHorizontal
                className="h-4 w-4"
                style={{ fill: "none", stroke: "currentColor" }}
              />
            </button>
          </div>
        </div>
      </header>

      {/* Toolbar row - matches original at y=105-157, height=52px */}
      <div
        className="flex h-[48px] shrink-0 items-center border-b px-4"
        style={{ borderColor: COLORS.border }}
      >
        <div className="flex w-full min-w-0 items-center">
          <button
            disabled
            title="Personal memories — coming soon"
            aria-label="Personal memories — coming soon"
            className="inline-flex shrink-0 cursor-not-allowed items-center whitespace-nowrap font-medium text-sm opacity-50"
            style={{
              color: COLORS.textPrimary,
              fontFamily:
                'Geist, "Geist Fallback", ui-sans-serif, system-ui, sans-serif',
              minHeight: "44px",
              padding: "0px 10px",
              marginRight: "12px",
              width: "169px",
              justifyContent: "flex-start",
            }}
          >
            <span className="truncate font-medium">Personal memories</span>
          </button>
          <button
            disabled
            title="Select — coming soon"
            aria-label="Select — coming soon"
            className="inline-flex shrink-0 cursor-not-allowed items-center justify-center whitespace-nowrap rounded-md font-medium text-sm opacity-50"
            style={{
              color: COLORS.textSecondary,
              padding: "0px 10px",
              fontFamily:
                'Geist, "Geist Fallback", ui-sans-serif, system-ui, sans-serif',
              minHeight: "44px",
              width: "88px",
              marginLeft: "auto",
            }}
          >
            Select
          </button>
          <span
            className="ml-3 hidden whitespace-nowrap text-sm md:inline"
            style={{ color: COLORS.textSecondary }}
          >
            {memories.length} memories
          </span>
          <div className="ml-auto hidden min-w-0 items-center gap-2 md:flex">
            <button
              disabled
              title="Filters — coming soon"
              aria-label="Filters — coming soon"
              className="inline-flex shrink-0 cursor-not-allowed items-center justify-center whitespace-nowrap rounded-md font-medium text-sm opacity-50"
              style={{
                color: COLORS.textPrimary,
                padding: "10px 14px",
                minHeight: "44px",
                backgroundColor: "transparent",
                border: `1px solid ${COLORS.border}`,
              }}
            >
              Filters
            </button>
            <div className="relative w-64 min-w-[10rem]">
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
          <ul role="list" className="m-0 list-none p-0">
            {filtered.map((memory) => (
              <li
                key={memory.id}
                className="group relative flex w-full select-none items-start gap-3 border-b px-6 py-3 text-left transition-colors"
                style={{
                  borderColor: COLORS.cardBorder,
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = COLORS.hoverBg;
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = "transparent";
                }}
              >
                <div className="min-w-0 flex-1">
                  <p
                    className="line-clamp-2 break-words text-sm"
                    style={{ color: COLORS.textPrimary }}
                    title={memory.content}
                  >
                    {memory.content}
                  </p>
                  <div className="mt-2 flex min-w-0 items-center gap-1.5">
                    <span
                      className="truncate text-xs"
                      style={{ color: COLORS.textSecondary }}
                    >
                      {memory.createdAt
                        ? new Date(memory.createdAt).toLocaleString()
                        : "Saved memory"}
                    </span>
                  </div>
                </div>
                <div className="reveal-on-hover flex shrink-0 items-center gap-1 transition-opacity">
                  <button
                    disabled
                    title="Pin memory — coming soon"
                    aria-label="Pin memory — coming soon"
                    className="flex cursor-not-allowed items-center justify-center rounded-md min-w-[44px] min-h-[44px] p-2.5 opacity-50 transition-colors"
                    style={{ color: COLORS.textSecondary }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.backgroundColor = COLORS.hoverBg;
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.backgroundColor = "transparent";
                    }}
                  >
                    <Pin
                      className="h-4 w-4"
                      style={{ fill: "none", stroke: "currentColor" }}
                    />
                  </button>
                  <button
                    onClick={() => handleDelete(memory.id)}
                    aria-label="Delete memory"
                    className="flex cursor-pointer items-center justify-center rounded-md min-w-[44px] min-h-[44px] p-2.5 transition-colors"
                    style={{ color: COLORS.textSecondary }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.backgroundColor = COLORS.hoverBg;
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.backgroundColor = "transparent";
                    }}
                  >
                    <Trash2
                      className="h-4 w-4"
                      style={{ fill: "none", stroke: "currentColor" }}
                    />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
