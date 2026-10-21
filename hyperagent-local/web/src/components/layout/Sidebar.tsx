import { Link, useLocation } from "react-router-dom";
import { useUiStore } from "@/stores/ui-store";
import { useAuthStore } from "@/stores/auth-store";
import { useThreadsStore } from "@/stores/threads-store";
import { apiGet } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { nextPrimeWorkspaceId } from "@/lib/prime-workspace";
import {
  MessageSquarePlus,
  Search,
  Inbox,
  Plus,
  Bot,
  ChevronDown,
  ChevronRight,
  Sparkles,
  Brain,
  Store,
  PanelLeftClose,
  PanelLeftOpen,
  Library,
} from "lucide-react";
import { useState, useEffect, useRef, memo } from "react";
import { APP_NAME } from "@/lib/branding";
import { COLORS } from "@/lib/theme-colors";

interface WorkspaceOption {
  id: number;
  name: string;
}

const NavLink = memo(function NavLink({
  to,
  icon: Icon,
  label,
  collapsed,
  isActiveOverride,
}: {
  to: string;
  icon: React.ElementType;
  label: string;
  collapsed: boolean;
  isActiveOverride?: boolean;
}) {
  const location = useLocation();
  const isActive =
    isActiveOverride ??
    (location.pathname === to ||
      (to !== "/threads" && location.pathname.startsWith(to)));
  return (
    <Link
      to={to}
      className={cn(
        "flex min-h-[44px] w-full cursor-pointer items-center gap-2 overflow-hidden rounded-md px-3.5 py-1.5 text-sm transition-colors duration-200 ease-out",
        isActive ? "text-white" : "hover:text-white",
        collapsed ? "justify-center px-2" : "",
      )}
      title={collapsed ? label : undefined}
      style={{
        fontFamily:
          'Geist, "Geist Fallback", ui-sans-serif, system-ui, sans-serif',
        color: isActive ? COLORS.textPrimary : COLORS.textSecondary,
        backgroundColor: isActive ? COLORS.activeBg : "transparent",
      }}
      onMouseEnter={(e) => {
        if (!isActive) e.currentTarget.style.backgroundColor = COLORS.hoverBg;
      }}
      onMouseLeave={(e) => {
        if (!isActive) e.currentTarget.style.backgroundColor = "transparent";
      }}
    >
      <Icon
        className="h-4 w-4 flex-shrink-0"
        aria-hidden="true"
        style={{ fill: "none", stroke: "currentColor" }}
      />
      {!collapsed && <span className="truncate">{label}</span>}
    </Link>
  );
});

export function Sidebar() {
  const sidebarCollapsed = useUiStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  const activeWorkspaceId = useUiStore((s) => s.activeWorkspaceId);
  const setActiveWorkspace = useUiStore((s) => s.setActiveWorkspace);
  const user = useAuthStore((s) => s.user);
  const recentThreads = useThreadsStore((s) => s.threads);
  const threadsLoading = useThreadsStore((s) => s.isLoading);
  const threadsFetchError = useThreadsStore((s) => s.fetchError);
  const fetchThreads = useThreadsStore((s) => s.fetchThreads);
  const [workspaces, setWorkspaces] = useState<WorkspaceOption[]>([]);
  // Prime the recent-threads list when landing on a page that never fetched
  // threads (e.g. a cold load of /memories). Primed once per workspace: the
  // store's loading/error flags must not be dependencies — a completed
  // empty fetch flips isLoading back to false with the list still empty,
  // which would re-enter the effect and refetch forever until the rate
  // limiter 429s. A workspace change still primes (ThreadListPage's own
  // effect also refetches on workspace switch via the shared store).
  const primedWorkspaceRef = useRef<number | null>(null);
  useEffect(() => {
    const target = nextPrimeWorkspaceId(
      primedWorkspaceRef.current,
      activeWorkspaceId,
      recentThreads.length,
    );
    if (target === null) return;
    primedWorkspaceRef.current = target;
    fetchThreads(target);
  }, [recentThreads.length, fetchThreads, activeWorkspaceId]);
  useEffect(() => {
    if (!user) {
      setWorkspaces([]);
      return;
    }
    let cancelled = false;
    void apiGet<WorkspaceOption[]>("/workspaces")
      .then((rows) => {
        if (!cancelled) setWorkspaces(rows);
      })
      .catch(() => {
        if (!cancelled) setWorkspaces([]);
      });
    return () => {
      cancelled = true;
    };
  }, [user]);
  const [threadsOpen, setThreadsOpen] = useState(true);
  const [personalOpen, setPersonalOpen] = useState(true);
  const activeWorkspaceName =
    workspaces.find((w) => w.id === activeWorkspaceId)?.name ?? "Personal";

  return (
    <div
      className="flex h-full flex-col border-r"
      style={{
        backgroundColor: COLORS.bg,
        borderColor: COLORS.border,
        width: sidebarCollapsed ? "64px" : "260px",
        fontFamily:
          'Geist, "Geist Fallback", ui-sans-serif, system-ui, sans-serif',
      }}
    >
      {/* Header - matches original: h-14 (56px), pl-[22px], pr-3, mt-1 */}
      <div
        className={cn(
          "mt-1 flex shrink-0 items-center gap-2 overflow-hidden pl-[22px] h-14 pr-3",
          sidebarCollapsed && "justify-center px-2",
        )}
      >
        {!sidebarCollapsed && (
          <Link to="/threads/new" className="flex items-center gap-2">
            <Sparkles
              className="h-[24px] w-[24px]"
              aria-hidden="true"
              style={{
                fill: "none",
                stroke: "currentColor",
                color: COLORS.textPrimary,
              }}
            />
            <span
              className="whitespace-nowrap font-semibold"
              style={{
                fontFamily:
                  'seasonSans, "seasonSans Fallback", ui-sans-serif, system-ui, sans-serif',
                color: COLORS.textPrimary,
              }}
            >
              {APP_NAME}
            </span>
          </Link>
        )}
        {sidebarCollapsed && (
          <Sparkles
            className="h-[24px] w-[24px]"
            aria-hidden="true"
            style={{
              fill: "none",
              stroke: "currentColor",
              color: COLORS.textPrimary,
            }}
          />
        )}
      </div>

      {/* Nav */}
      <nav
        aria-label="Main navigation"
        className="flex-1 space-y-1 overflow-y-auto px-2 py-3"
      >
        {/* Personal dropdown */}
        {!sidebarCollapsed && (
          <div id="personal-section">
            <button
              onClick={() => setPersonalOpen(!personalOpen)}
              aria-expanded={personalOpen}
              aria-controls="personal-section"
              className="group -mt-2 mb-2 flex min-h-11 w-full items-center gap-2 overflow-hidden rounded-md py-1.5 pr-[11px] pl-[13px] text-sm transition-colors"
              style={{
                fontFamily:
                  'Geist, "Geist Fallback", ui-sans-serif, system-ui, sans-serif',
                color: COLORS.textPrimary,
                border: `1px solid ${COLORS.border}`,
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.backgroundColor = COLORS.hoverBg;
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.backgroundColor = "transparent";
              }}
            >
              <div
                className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold"
                style={{
                  backgroundColor: COLORS.avatarBg,
                  color: COLORS.textPrimary,
                }}
              >
                {activeWorkspaceName.charAt(0).toUpperCase()}
              </div>
              <span className="min-w-0 flex-1 truncate font-medium">
                {activeWorkspaceName}
              </span>
              <ChevronDown
                className={cn(
                  "h-3.5 w-3.5 shrink-0 transition-transform",
                  !personalOpen && "-rotate-90",
                )}
                aria-hidden="true"
                style={{
                  fill: "none",
                  stroke: "currentColor",
                  color: COLORS.textSecondary,
                }}
              />
            </button>
            {personalOpen && workspaces.length > 1 && (
              <div className="mb-2">
                <label htmlFor="sidebar-workspace" className="sr-only">
                  Workspace
                </label>
                <select
                  id="sidebar-workspace"
                  value={activeWorkspaceId}
                  onChange={(e) => setActiveWorkspace(Number(e.target.value))}
                  className="w-full rounded-md border px-2 py-1.5 text-sm min-h-[44px]"
                  style={{
                    borderColor: COLORS.border,
                    backgroundColor: COLORS.inputBg,
                    color: COLORS.textPrimary,
                  }}
                >
                  {workspaces.map((ws) => (
                    <option key={ws.id} value={ws.id}>
                      {ws.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>
        )}

        <NavLink
          to="/threads/new"
          icon={MessageSquarePlus}
          label="New thread"
          collapsed={sidebarCollapsed}
        />

        <button
          onClick={() => useUiStore.getState().openCommandPalette()}
          className={cn(
            "group flex w-full items-center gap-2 overflow-hidden rounded-md px-3.5 py-1.5 text-sm transition-all duration-200 ease-out",
            sidebarCollapsed && "justify-center px-2",
          )}
          aria-label="Search (⌘K)"
          title={sidebarCollapsed ? "Search (⌘K)" : undefined}
          style={{
            fontFamily:
              'Geist, "Geist Fallback", ui-sans-serif, system-ui, sans-serif',
            color: COLORS.textSecondary,
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor = COLORS.hoverBg;
            e.currentTarget.style.color = COLORS.textPrimary;
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = "transparent";
            e.currentTarget.style.color = COLORS.textSecondary;
          }}
        >
          <Search
            className="h-4 w-4 flex-shrink-0"
            aria-hidden="true"
            style={{ fill: "none", stroke: "currentColor" }}
          />
          {!sidebarCollapsed && (
            <>
              <span className="flex-1 text-left">Search</span>
              <kbd
                className="rounded border px-1.5 py-0.5 text-xs"
                style={{
                  borderColor: COLORS.border,
                  backgroundColor: COLORS.kbdBg,
                  color: COLORS.textSecondary,
                }}
              >
                ⌘K
              </kbd>
            </>
          )}
        </button>

        <NavLink
          to="/inbox"
          icon={Inbox}
          label="Inbox"
          collapsed={sidebarCollapsed}
        />

        <NavLink
          to="/agents"
          icon={Bot}
          label="Agents"
          collapsed={sidebarCollapsed}
        />

        {/* Recent threads */}
        {!sidebarCollapsed && (
          <div className="pt-2">
            <div className="flex items-center">
              <button
                onClick={() => setThreadsOpen(!threadsOpen)}
                aria-expanded={threadsOpen}
                aria-controls="threads-section"
                className="flex min-h-11 min-w-0 flex-1 items-center gap-1 rounded-md pl-3.5 text-xs font-medium uppercase tracking-wider transition-colors"
                style={{
                  fontFamily:
                    'Geist, "Geist Fallback", ui-sans-serif, system-ui, sans-serif',
                  color: COLORS.textSecondary,
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.color = COLORS.textPrimary;
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.color = COLORS.textSecondary;
                }}
              >
                {threadsOpen ? (
                  <ChevronDown className="h-3 w-3" aria-hidden="true" />
                ) : (
                  <ChevronRight className="h-3 w-3" aria-hidden="true" />
                )}
                Recent threads
              </button>
              <Link
                to="/threads/new"
                className="flex shrink-0 items-center justify-center rounded-md p-1 transition-colors"
                style={{ color: COLORS.textSecondary }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = COLORS.hoverBg;
                  e.currentTarget.style.color = COLORS.textPrimary;
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = "transparent";
                  e.currentTarget.style.color = COLORS.textSecondary;
                }}
                aria-label="Create new thread"
              >
                <Plus
                  className="h-3.5 w-3.5"
                  aria-hidden="true"
                  style={{ fill: "none", stroke: "currentColor" }}
                />
              </Link>
            </div>
            {threadsOpen && (
              <div id="threads-section" className="mt-1 space-y-0.5">
                {recentThreads.slice(0, 5).map((thread) => (
                  <Link
                    key={thread.id}
                    to={`/threads/${thread.id}`}
                    className="flex flex-1 items-start gap-2 overflow-hidden rounded-md py-2 pl-3.5 pr-3.5 text-sm transition-colors"
                    style={{ color: COLORS.textPrimary }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.backgroundColor = COLORS.hoverBg;
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.backgroundColor = "transparent";
                    }}
                  >
                    <div
                      className="flex h-5 w-5 shrink-0 items-center justify-center rounded-[6px] text-[10px] font-medium"
                      style={{
                        backgroundColor: COLORS.avatarBg,
                        color: COLORS.textSecondary,
                      }}
                    >
                      {(thread.title?.[0] ?? "T").toUpperCase()}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div
                        className="truncate font-medium"
                        title={thread.title ?? `Thread ${thread.id}`}
                      >
                        {thread.title ?? `Thread ${thread.id}`}
                      </div>
                    </div>
                  </Link>
                ))}
                {!threadsLoading &&
                  !threadsFetchError &&
                  recentThreads.length === 0 && (
                    <p
                      className="px-3.5 py-1.5 text-xs"
                      style={{ color: COLORS.textSecondary }}
                    >
                      No threads yet
                    </p>
                  )}
                {threadsFetchError && recentThreads.length === 0 && (
                  <div
                    role="alert"
                    className="flex items-center justify-between gap-2 px-3.5 py-1.5"
                  >
                    <p
                      className="text-xs"
                      style={{ color: COLORS.textSecondary }}
                    >
                      Couldn&apos;t load threads
                    </p>
                    <button
                      onClick={() => {
                        void fetchThreads(activeWorkspaceId);
                      }}
                      className="shrink-0 rounded-md px-2 py-1 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
                      style={{
                        color: COLORS.textPrimary,
                        backgroundColor: COLORS.hoverBg,
                      }}
                    >
                      Retry
                    </button>
                  </div>
                )}
                <Link
                  to="/threads"
                  className="flex w-full cursor-pointer items-center gap-2 overflow-hidden rounded-md px-3.5 py-1.5 text-sm transition-all duration-200 ease-out"
                  style={{ color: COLORS.textSecondary }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.backgroundColor = COLORS.hoverBg;
                    e.currentTarget.style.color = COLORS.textPrimary;
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.backgroundColor = "transparent";
                    e.currentTarget.style.color = COLORS.textSecondary;
                  }}
                >
                  View all
                  <ChevronRight
                    className="ml-auto h-3 w-3"
                    aria-hidden="true"
                    style={{ fill: "none", stroke: "currentColor" }}
                  />
                </Link>
              </div>
            )}
          </div>
        )}

        {/* Resources - mt-3 wrapper matching original at y=494 */}
        <div className={cn("mt-3", sidebarCollapsed && "space-y-1")}>
          {!sidebarCollapsed && (
            <div
              className="mb-1 flex items-center gap-1 py-1.5 pl-3.5 pr-1 text-xs font-medium"
              style={{
                fontFamily:
                  'Geist, "Geist Fallback", ui-sans-serif, system-ui, sans-serif',
                color: COLORS.textSecondary,
              }}
            >
              Resources
            </div>
          )}
          {/* space-y-0.5 wrapper matching original at y=522 */}
          <div className="space-y-0.5">
            <NavLink
              to="/skills"
              icon={Sparkles}
              label="Skills"
              collapsed={sidebarCollapsed}
            />
            <NavLink
              to="/memories"
              icon={Brain}
              label="Memories"
              collapsed={sidebarCollapsed}
            />
            <NavLink
              to="/library"
              icon={Library}
              label="Library"
              collapsed={sidebarCollapsed}
            />
            <NavLink
              to="/marketplace"
              icon={Store}
              label="Marketplace"
              collapsed={sidebarCollapsed}
            />
          </div>
        </div>

        {/* User profile inside nav - matching original at y=538-600 */}
        {!sidebarCollapsed && user && (
          <div className="shrink-0 space-y-0.5 p-2">
            <Link
              to="/settings"
              aria-label="Profile settings"
              className="inline-flex w-full items-center gap-2 whitespace-nowrap rounded-md font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
              style={{ color: COLORS.textPrimary, padding: "8px 12px" }}
              onMouseEnter={(e) => {
                e.currentTarget.style.backgroundColor = COLORS.hoverBg;
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.backgroundColor = "transparent";
              }}
            >
              <div
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold"
                style={{
                  backgroundColor: COLORS.avatarBg,
                  color: COLORS.textPrimary,
                }}
              >
                {user.displayName?.[0]?.toUpperCase() ||
                  user.email[0].toUpperCase()}
              </div>
              <div className="min-w-0 flex-1 text-left">
                <div className="truncate font-medium text-xs leading-4">
                  {user.displayName || user.email}
                </div>
                <div
                  className="truncate text-xs leading-4"
                  style={{ color: COLORS.textSecondary }}
                >
                  {user.email}
                </div>
              </div>
              <ChevronRight
                className="h-3.5 w-3.5 shrink-0"
                aria-hidden="true"
                style={{
                  fill: "none",
                  stroke: "currentColor",
                  color: COLORS.textSecondary,
                }}
              />
            </Link>
          </div>
        )}
      </nav>

      {/* Footer - collapse toggle only */}
      <div className="p-2">
        <button
          onClick={toggleSidebar}
          className="flex w-full items-center justify-center rounded-[12px] p-2 transition-colors"
          style={{ color: COLORS.textSecondary }}
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor = COLORS.hoverBg;
            e.currentTarget.style.color = COLORS.textPrimary;
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = "transparent";
            e.currentTarget.style.color = COLORS.textSecondary;
          }}
          aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          {sidebarCollapsed ? (
            <PanelLeftOpen
              className="h-[24px] w-[24px]"
              aria-hidden="true"
              style={{ fill: "none", stroke: "currentColor" }}
            />
          ) : (
            <PanelLeftClose
              className="h-[24px] w-[24px]"
              aria-hidden="true"
              style={{ fill: "none", stroke: "currentColor" }}
            />
          )}
        </button>
      </div>
    </div>
  );
}
