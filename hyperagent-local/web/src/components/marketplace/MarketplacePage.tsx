import { useCallback, useEffect, useRef, useState } from "react";
import { apiGet, apiPost } from "@/lib/api-client";
import type { Skill, Agent } from "@/types/api";
import { Store, Search, Download, Sparkles, Bot, Check } from "lucide-react";
import { LoadingIndicator } from "@/components/ui/LoadingIndicator";
import { EmptyState } from "@/components/ui/EmptyState";
import { COLORS } from "@/lib/theme-colors";
import { useUiStore } from "@/stores/ui-store";
import { useToast } from "@/hooks/useToast";

type Category = "skills" | "agents";

const SEARCH_DEBOUNCE_MS = 275;

export function MarketplacePage() {
  const { showToast } = useToast();
  const [category, setCategory] = useState<Category>("skills");
  const [searchTerm, setSearchTerm] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [items, setItems] = useState<(Skill | Agent)[]>([]);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);
  // Tracks which items are currently being installed or have been installed.
  // Keyed by `${category}:${id}` to avoid collisions across types.
  const [installState, setInstallState] = useState<
    Record<string, "installing" | "installed" | "error">
  >({});
  // Guards against out-of-order responses: a slow request for a previous
  // category/search/offset must not overwrite newer results.
  const requestIdRef = useRef(0);
  // Mirrors the current category/search for loadMore: appending must not mix
  // rows from a category the user has already navigated away from.
  const categoryRef = useRef(category);
  const searchRef = useRef(debouncedSearch);
  useEffect(() => {
    categoryRef.current = category;
    searchRef.current = debouncedSearch;
  }, [category, debouncedSearch]);

  useEffect(() => {
    const handle = window.setTimeout(() => {
      setDebouncedSearch(searchTerm);
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [searchTerm]);

  const loadItems = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    const seenCategory = category;
    const seenSearch = debouncedSearch;
    setIsLoading(true);
    setLoadError(null);
    try {
      const params: Record<string, string> = { category: seenCategory };
      if (seenSearch) params.search = seenSearch;
      const data = await apiGet<{
        type: string;
        items: (Skill | Agent)[];
        total: number;
      }>("/marketplace", params);
      if (requestIdRef.current !== requestId) return;
      setItems(data.items);
      setTotal(data.total);
    } catch (err) {
      if (requestIdRef.current !== requestId) return;
      // Drop the previous category's rows: leaving them up paints stale
      // results under the new category's chrome, with a working Show more
      // that would append the new category onto the old list.
      setItems([]);
      setTotal(0);
      setLoadError(
        err instanceof Error ? err.message : "Failed to load marketplace",
      );
    } finally {
      // Only the latest request clears the spinner; a stale finisher must
      // not hide the newer request's loading state.
      if (requestIdRef.current === requestId) setIsLoading(false);
    }
  }, [category, debouncedSearch]);

  useEffect(() => {
    void loadItems();
  }, [loadItems]);

  const loadMore = async () => {
    const requestId = ++requestIdRef.current;
    const seenOffset = items.length;
    const seenCategory = category;
    const seenSearch = debouncedSearch;
    setLoadError(null);
    const params: Record<string, string> = {
      category,
      offset: String(seenOffset),
    };
    if (seenSearch) params.search = seenSearch;
    try {
      const data = await apiGet<{
        type: string;
        items: (Skill | Agent)[];
        total: number;
      }>("/marketplace", params);
      if (requestIdRef.current !== requestId) return;
      // The user may have switched category/search mid-request: never append
      // rows fetched for a different filter onto the current list.
      if (
        categoryRef.current !== seenCategory ||
        searchRef.current !== seenSearch
      )
        return;
      setItems((prev) => {
        // The list may have been replaced since this request started; only
        // append when the base still matches the requested offset.
        if (prev.length !== seenOffset) return prev;
        return [...prev, ...data.items];
      });
      setTotal(data.total);
    } catch (err) {
      if (requestIdRef.current !== requestId) return;
      setLoadError(
        err instanceof Error ? err.message : "Failed to load more items",
      );
    }
  };

  // Local-mode install: copies a community skill/agent into the caller's
  // personal workspace via POST /marketplace/:type/:id/install. The backend
  // clones the DB row as a non-community, approved item. Items that would
  // require external download are not present in local mode (the marketplace
  // GET only returns DB-backed rows), so every listed item is installable.
  const handleInstall = async (item: Skill | Agent) => {
    const key = `${category}:${item.id}`;
    if (installState[key] === "installing" || installState[key] === "installed")
      return;
    setInstallState((prev) => ({ ...prev, [key]: "installing" }));
    setInstallError(null);
    try {
      const workspaceId = useUiStore.getState().activeWorkspaceId;
      await apiPost(`/marketplace/${category}/${item.id}/install`, {
        workspaceId: workspaceId ?? undefined,
      });
      setInstallState((prev) => ({ ...prev, [key]: "installed" }));
      showToast(`Installed ${item.name}`);
    } catch (err) {
      setInstallState((prev) => ({
        ...prev,
        [key]: "error",
      }));
      setInstallError(
        err instanceof Error ? err.message : `Failed to install ${item.name}`,
      );
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div
        className="flex items-center justify-between border-b px-6 py-4"
        style={{
          borderColor: COLORS.border,
          height: "104px",
          boxSizing: "border-box",
        }}
      >
        <div className="flex items-center gap-3">
          <div
            className="flex h-10 w-10 items-center justify-center rounded-lg"
            style={{
              backgroundColor: COLORS.avatarBg,
              color: COLORS.textPrimary,
            }}
          >
            <Store className="h-5 w-5" />
          </div>
          <div>
            <h1
              className="text-xl font-bold"
              style={{ color: COLORS.textPrimary }}
            >
              Marketplace
            </h1>
            <p className="text-sm" style={{ color: COLORS.textSecondary }}>
              Discover and install community skills and agents.
            </p>
          </div>
        </div>
      </div>

      <div
        className="flex h-[48px] items-center gap-3 border-b px-6 py-3"
        style={{ borderColor: COLORS.border }}
      >
        <div
          className="flex rounded-lg border"
          style={{ borderColor: COLORS.border }}
        >
          {(["skills", "agents"] as const).map((cat) => (
            <button
              key={cat}
              onClick={() => setCategory(cat)}
              aria-pressed={category === cat}
              className="px-4 py-2 text-sm font-medium capitalize first:rounded-l-lg last:rounded-r-lg transition-colors"
              style={{
                backgroundColor:
                  category === cat ? COLORS.activeBg : "transparent",
                color:
                  category === cat ? COLORS.textPrimary : COLORS.textSecondary,
              }}
            >
              {cat}
            </button>
          ))}
        </div>
        <div className="relative flex-1 max-w-md">
          <Search
            className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2"
            style={{ color: COLORS.textSecondary }}
          />
          <input
            type="text"
            placeholder={`Search ${category}…`}
            aria-label={`Search ${category}`}
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full rounded-lg border py-2 pl-9 pr-3 text-sm focus:outline-none focus:ring-1"
            style={{
              borderColor: COLORS.border,
              backgroundColor: COLORS.inputBg,
              color: COLORS.textPrimary,
            }}
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        {isLoading ? (
          <LoadingIndicator label="Loading marketplace" />
        ) : loadError && items.length === 0 ? (
          <EmptyState
            alert
            icon={Store}
            title="Couldn't load the marketplace"
            description={loadError}
            action={
              <button
                onClick={loadItems}
                className="mt-4 rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-primary-950 hover:bg-primary-700"
              >
                Retry
              </button>
            }
          />
        ) : items.length === 0 ? (
          <EmptyState
            icon={Store}
            title={`No ${category} found in marketplace`}
          />
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {items.map((item) => (
              <div
                key={item.id}
                className="group rounded-lg border p-4 transition-colors"
                style={{
                  borderColor: COLORS.cardBorder,
                  backgroundColor: COLORS.bg,
                }}
              >
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    <div
                      className="flex h-10 w-10 items-center justify-center rounded-lg"
                      style={{
                        backgroundColor: COLORS.avatarBg,
                        color: COLORS.textPrimary,
                      }}
                    >
                      {category === "skills" ? (
                        <Sparkles className="h-5 w-5" />
                      ) : (
                        <Bot className="h-5 w-5" />
                      )}
                    </div>
                    <div>
                      <h2
                        className="font-medium"
                        style={{ color: COLORS.textPrimary }}
                      >
                        {item.name}
                      </h2>
                      <span
                        className="text-xs"
                        style={{ color: COLORS.textSecondary }}
                      >
                        {"publisherId" in item && item.publisherId
                          ? "Community"
                          : "Official"}
                      </span>
                    </div>
                  </div>
                  {(() => {
                    const key = `${category}:${item.id}`;
                    const state = installState[key];
                    if (state === "installed") {
                      return (
                        <span
                          className="flex items-center gap-1 rounded-lg border px-2 py-1 text-xs font-medium"
                          style={{
                            borderColor: COLORS.border,
                            color: COLORS.successText,
                          }}
                        >
                          <Check className="h-3 w-3" /> Installed
                        </span>
                      );
                    }
                    const isInstalling = state === "installing";
                    return (
                      <button
                        onClick={() => handleInstall(item)}
                        disabled={isInstalling}
                        title={
                          isInstalling
                            ? "Installing..."
                            : "Install to local workspace"
                        }
                        className="flex items-center gap-1 rounded-lg border px-2 py-1 text-xs font-medium transition-colors hover:bg-white/5"
                        style={{
                          borderColor: COLORS.border,
                          color: COLORS.textPrimary,
                          opacity: isInstalling ? 0.6 : 1,
                          cursor: isInstalling ? "wait" : "pointer",
                        }}
                      >
                        {isInstalling ? (
                          <>
                            <span
                              className="block h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent"
                              aria-hidden="true"
                            />{" "}
                            Installing
                          </>
                        ) : (
                          <>
                            <Download className="h-3 w-3" /> Install
                          </>
                        )}
                      </button>
                    );
                  })()}
                </div>
                {item.description && (
                  <p
                    className="mt-3 text-sm line-clamp-2"
                    title={item.description}
                    style={{ color: COLORS.textSecondary }}
                  >
                    {item.description}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
        {!isLoading && loadError && items.length > 0 && (
          <p
            role="alert"
            className="mx-auto mb-4 max-w-3xl rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-center text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300"
          >
            {loadError}
          </p>
        )}
        {installError && (
          <p
            role="alert"
            className="mx-auto mb-4 max-w-3xl rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-center text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300"
          >
            {installError}
          </p>
        )}
        {!isLoading && items.length > 0 && items.length < total && (
          <div className="flex justify-center pb-6">
            <button
              onClick={loadMore}
              className="rounded-lg border px-4 py-2 text-sm font-medium transition-colors"
              style={{
                borderColor: COLORS.border,
                color: COLORS.textSecondary,
              }}
            >
              Show more ({items.length} of {total})
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
