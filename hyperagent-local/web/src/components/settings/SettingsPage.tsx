import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuthStore } from "@/stores/auth-store";
import { useUiStore } from "@/stores/ui-store";
import { apiGet, apiPut, apiPost, apiDelete } from "@/lib/api-client";
import type { User, McpServer } from "@/types/api";
import {
  Settings,
  User as UserIcon,
  Server,
  Plus,
  Trash2,
  Save,
  X,
  CheckCircle2,
  CircleX,
  LogOut,
  BarChart3,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { LoadingIndicator } from "@/components/ui/LoadingIndicator";
import { EmptyState } from "@/components/ui/EmptyState";
import { COLORS } from "@/lib/theme-colors";

const SAVE_FEEDBACK_DURATION_MS = 2000;

type Tab = "profile" | "usage" | "mcp-servers";
type TransportType = "stdio" | "sse" | "streamable-http";

const DEFAULT_STDIO_CONFIG = `{
  "command": "node",
  "args": ["-e", "console.error('replace with an MCP stdio server')"]
}`;

const DEFAULT_HTTP_CONFIG = `{
  "url": "http://127.0.0.1:3001/mcp"
}`;

function probeButtonLabel(
  state:
    | { status: "idle" | "running" | "ok" | "error"; detail?: string }
    | undefined,
): string {
  if (!state || state.status === "idle") return "Test";
  if (state.status === "running") return "Testing…";
  if (state.status === "ok") return `OK · ${state.detail ?? "Connected"}`;
  const detail = state.detail?.trim();
  if (!detail) return "Failed";
  return detail.length > 48
    ? `Failed · ${detail.slice(0, 45)}…`
    : `Failed · ${detail}`;
}

const TABS = [
  { id: "profile", label: "Profile", icon: UserIcon },
  { id: "usage", label: "Usage", icon: BarChart3 },
  { id: "mcp-servers", label: "MCP Servers", icon: Server },
] as const;

export function SettingsPage() {
  const [activeTab, setActiveTab] = useState<Tab>("profile");
  const user = useAuthStore((s) => s.user);
  const tabRefs = useRef<Map<string, HTMLButtonElement>>(new Map());

  const handleTabKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const tabs = TABS.map((t) => t.id);
      const currentIndex = tabs.indexOf(activeTab);
      let nextIndex: number | null = null;

      if (e.key === "ArrowRight") {
        nextIndex = (currentIndex + 1) % tabs.length;
      } else if (e.key === "ArrowLeft") {
        nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
      } else if (e.key === "Home") {
        nextIndex = 0;
      } else if (e.key === "End") {
        nextIndex = tabs.length - 1;
      }

      if (nextIndex !== null) {
        e.preventDefault();
        const nextTab = tabs[nextIndex];
        setActiveTab(nextTab);
        tabRefs.current.get(nextTab)?.focus();
      }
    },
    [activeTab],
  );

  return (
    <div className="flex h-full flex-col">
      <div
        className="flex items-center gap-3 px-6 py-4"
        style={{
          height: "104px",
          boxSizing: "border-box",
          borderBottom: `1px solid ${COLORS.border}`,
        }}
      >
        <div
          className="flex h-10 w-10 items-center justify-center rounded-lg"
          style={{
            backgroundColor: COLORS.avatarBg,
            color: COLORS.textPrimary,
          }}
        >
          <Settings className="h-5 w-5" />
        </div>
        <h1 className="text-xl font-bold" style={{ color: COLORS.textPrimary }}>
          Settings
        </h1>
      </div>

      <div
        role="tablist"
        className="flex"
        style={{ borderBottom: `1px solid ${COLORS.border}` }}
        onKeyDown={handleTabKeyDown}
      >
        {TABS.map((tab) => (
          <button
            key={tab.id}
            ref={(el) => {
              if (el) tabRefs.current.set(tab.id, el);
            }}
            id={`tab-${tab.id}`}
            role="tab"
            tabIndex={activeTab === tab.id ? 0 : -1}
            aria-selected={activeTab === tab.id}
            aria-controls={`panel-${tab.id}`}
            onClick={() => setActiveTab(tab.id)}
            className={cn(
              "flex items-center gap-2 border-b-2 px-6 py-3 text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2",
              activeTab === tab.id
                ? "border-primary-600"
                : "border-transparent",
            )}
            style={{
              color:
                activeTab === tab.id
                  ? COLORS.textPrimary
                  : COLORS.textSecondary,
            }}
          >
            <tab.icon className="h-4 w-4" />
            {tab.label}
          </button>
        ))}
      </div>

      <div
        role="tabpanel"
        id={`panel-${activeTab}`}
        aria-labelledby={`tab-${activeTab}`}
        className="flex-1 overflow-y-auto p-6"
      >
        {activeTab === "profile" && <ProfileSection user={user} />}
        {activeTab === "usage" && <UsageSection />}
        {activeTab === "mcp-servers" && <McpServersSection />}
      </div>
    </div>
  );
}

interface BillingStatus {
  stub: boolean;
  localMode: boolean;
  plan: string;
  status: string;
  billingCycleStart: string | null;
  billingCycleEnd: string | null;
}

interface BillingConsumption {
  stub: boolean;
  localMode: boolean;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  byModel: Record<
    string,
    { promptTokens: number; completionTokens: number; totalTokens: number }
  >;
  periodStart: string | null;
  periodEnd: string | null;
}

function UsageSection() {
  const [status, setStatus] = useState<BillingStatus | null>(null);
  const [consumption, setConsumption] = useState<BillingConsumption | null>(
    null,
  );
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const requestIdRef = useRef(0);

  useEffect(() => {
    const requestId = ++requestIdRef.current;
    setIsLoading(true);
    setLoadError(null);
    void (async () => {
      try {
        const [statusRes, consumptionRes] = await Promise.all([
          apiGet<BillingStatus>("/integrations/settings/billing/status"),
          apiGet<BillingConsumption>(
            "/integrations/settings/billing/consumption",
          ),
        ]);
        if (requestIdRef.current !== requestId) return;
        setStatus(statusRes);
        setConsumption(consumptionRes);
      } catch (err) {
        if (requestIdRef.current !== requestId) return;
        setLoadError(
          err instanceof Error ? err.message : "Failed to load usage",
        );
      } finally {
        if (requestIdRef.current === requestId) setIsLoading(false);
      }
    })();
  }, []);

  if (isLoading) {
    return <LoadingIndicator label="Loading usage" />;
  }
  if (loadError) {
    return (
      <p role="alert" className="text-sm text-red-600 dark:text-red-400">
        {loadError}
      </p>
    );
  }
  if (!status || !consumption) {
    return (
      <EmptyState
        icon={BarChart3}
        title="No usage data"
        description="Nothing recorded yet."
      />
    );
  }

  const modelEntries = Object.entries(consumption.byModel);

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div
        className="rounded-lg border p-6"
        style={{ borderColor: COLORS.cardBorder, backgroundColor: COLORS.bg }}
      >
        <h2
          className="mb-1 text-lg font-semibold"
          style={{ color: COLORS.textPrimary }}
        >
          Local usage
        </h2>
        <p className="mb-4 text-sm" style={{ color: COLORS.textSecondary }}>
          Plan <span className="font-medium">{status.plan}</span>
          {status.localMode ? " · local mode" : ""}. In-process token counters
          for this machine; they reset when the API restarts. Cloud billing,
          credits, and referrals are not part of local mode.
        </p>
        <dl className="grid grid-cols-3 gap-4 text-sm">
          <div>
            <dt style={{ color: COLORS.textSecondary }}>Prompt</dt>
            <dd
              className="text-lg font-semibold"
              style={{ color: COLORS.textPrimary }}
            >
              {consumption.promptTokens.toLocaleString()}
            </dd>
          </div>
          <div>
            <dt style={{ color: COLORS.textSecondary }}>Completion</dt>
            <dd
              className="text-lg font-semibold"
              style={{ color: COLORS.textPrimary }}
            >
              {consumption.completionTokens.toLocaleString()}
            </dd>
          </div>
          <div>
            <dt style={{ color: COLORS.textSecondary }}>Total</dt>
            <dd
              className="text-lg font-semibold"
              style={{ color: COLORS.textPrimary }}
            >
              {consumption.totalTokens.toLocaleString()}
            </dd>
          </div>
        </dl>
        {(consumption.periodStart || consumption.periodEnd) && (
          <p className="mt-4 text-xs" style={{ color: COLORS.textSecondary }}>
            {consumption.periodStart
              ? `From ${new Date(consumption.periodStart).toLocaleString()}`
              : null}
            {consumption.periodEnd
              ? ` · Last ${new Date(consumption.periodEnd).toLocaleString()}`
              : null}
          </p>
        )}
      </div>
      {modelEntries.length > 0 && (
        <div
          className="rounded-lg border p-6"
          style={{ borderColor: COLORS.cardBorder, backgroundColor: COLORS.bg }}
        >
          <h3
            className="mb-3 text-sm font-semibold"
            style={{ color: COLORS.textPrimary }}
          >
            By model
          </h3>
          <ul className="space-y-2 text-sm">
            {modelEntries.map(([model, usage]) => (
              <li
                key={model}
                className="flex items-center justify-between gap-3"
              >
                <span
                  className="truncate"
                  style={{ color: COLORS.textPrimary }}
                >
                  {model}
                </span>
                <span style={{ color: COLORS.textSecondary }}>
                  {usage.totalTokens.toLocaleString()} tokens
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function ProfileSection({ user }: { user: User | null }) {
  const navigate = useNavigate();
  const logout = useAuthStore((s) => s.logout);
  const [displayName, setDisplayName] = useState(user?.displayName || "");
  const [isSaving, setIsSaving] = useState(false);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setDisplayName(user?.displayName || "");
  }, [user?.id, user?.displayName]);

  useEffect(() => {
    return () => {
      if (savedTimerRef.current !== null) clearTimeout(savedTimerRef.current);
    };
  }, []);

  const handleLogout = async () => {
    setIsLoggingOut(true);
    try {
      await logout();
      navigate("/login", { replace: true });
    } finally {
      setIsLoggingOut(false);
    }
  };

  const handleSave = async () => {
    setIsSaving(true);
    setSaveError(null);
    try {
      const updated = await apiPut<User>("/settings/user", { displayName });
      // The sidebar renders the session user, so publish the saved profile
      // immediately instead of waiting for the next login/session check.
      useAuthStore.setState({ user: updated });
      setSaved(true);
      if (savedTimerRef.current !== null) clearTimeout(savedTimerRef.current);
      savedTimerRef.current = setTimeout(
        () => setSaved(false),
        SAVE_FEEDBACK_DURATION_MS,
      );
    } catch (err) {
      setSaveError(
        err instanceof Error ? err.message : "Failed to save profile",
      );
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div
        className="rounded-lg border p-6"
        style={{ borderColor: COLORS.cardBorder, backgroundColor: COLORS.bg }}
      >
        <h2
          className="mb-4 text-lg font-semibold"
          style={{ color: COLORS.textPrimary }}
        >
          Profile
        </h2>
        <div className="space-y-4">
          <div>
            <label
              htmlFor="settings-email"
              className="block text-sm font-medium"
              style={{ color: COLORS.textSecondary }}
            >
              Email
            </label>
            <input
              id="settings-email"
              type="email"
              disabled
              value={user?.email || ""}
              className="mt-1 block w-full rounded-lg border px-3 py-2 text-sm"
              style={{
                borderColor: COLORS.border,
                backgroundColor: COLORS.inputBg,
                color: COLORS.textSecondary,
              }}
            />
          </div>
          <div>
            <label
              htmlFor="settings-display-name"
              className="block text-sm font-medium"
              style={{ color: COLORS.textSecondary }}
            >
              Display Name
            </label>
            <input
              id="settings-display-name"
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              className="mt-1 block w-full rounded-lg border px-3 py-2 text-sm focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500"
              style={{
                borderColor: COLORS.border,
                backgroundColor: COLORS.inputBg,
                color: COLORS.textPrimary,
              }}
            />
          </div>
          <div className="flex flex-wrap items-center gap-3 pt-2">
            <button
              onClick={handleSave}
              disabled={isSaving}
              className="flex items-center gap-2 rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-primary-950 hover:bg-primary-700 disabled:opacity-50"
            >
              <Save className="h-4 w-4" />
              {isSaving ? "Saving…" : "Save Changes"}
            </button>
            <button
              type="button"
              onClick={() => void handleLogout()}
              disabled={isLoggingOut}
              className="flex items-center gap-2 rounded-lg border px-4 py-2 text-sm font-medium disabled:opacity-50"
              style={{
                borderColor: COLORS.border,
                color: COLORS.textPrimary,
                backgroundColor: COLORS.bg,
              }}
            >
              <LogOut className="h-4 w-4" />
              {isLoggingOut ? "Signing out…" : "Sign out"}
            </button>
            <span
              role="status"
              aria-live="polite"
              className="text-sm"
              style={{ color: COLORS.textSecondary }}
            >
              {saved ? "Saved!" : ""}
            </span>
            {saveError && (
              <span
                role="alert"
                aria-live="assertive"
                className="text-sm text-red-600 dark:text-red-400"
              >
                {saveError}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function McpServersSection() {
  const [servers, setServers] = useState<McpServer[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);

  const closeForm = useCallback(() => {
    setShowForm(false);
    setEditingId(null);
    setFormError(null);
  }, []);

  // Every open starts clean: submit failures must not linger into the next
  // Add/Edit session through a different open/close path.
  useEffect(() => {
    if (showForm) setFormError(null);
  }, [showForm]);

  // The form is inline (not a dialog), but keyboard users still expect
  // Escape to back out the same way Cancel does.
  useEffect(() => {
    if (!showForm) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeForm();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [showForm, closeForm]);

  const [deleteConfirmId, setDeleteConfirmId] = useState<number | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [probeState, setProbeState] = useState<
    Record<
      number,
      { status: "idle" | "running" | "ok" | "error"; detail?: string }
    >
  >({});
  const activeWorkspaceId = useUiStore((s) => s.activeWorkspaceId);
  const requestIdRef = useRef(0);
  const [formData, setFormData] = useState({
    name: "",
    transportType: "stdio" as "stdio" | "sse" | "streamable-http",
    config: DEFAULT_STDIO_CONFIG,
    isEnabled: true,
  });

  useEffect(() => {
    void loadServers();
  }, [activeWorkspaceId]);

  const loadServers = async () => {
    const requestId = ++requestIdRef.current;
    setIsLoading(true);
    setLoadError(null);
    setDeleteError(null);
    try {
      // Always send the signed-in workspace — never rely on a hardcoded default.
      const data = await apiGet<McpServer[]>("/mcp-servers", {
        workspaceId: activeWorkspaceId,
      });
      if (requestIdRef.current !== requestId) return;
      setServers(data);
    } catch (err) {
      if (requestIdRef.current !== requestId) return;
      setServers([]);
      setLoadError(
        err instanceof Error ? err.message : "Failed to load MCP servers",
      );
    } finally {
      if (requestIdRef.current === requestId) setIsLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    try {
      const config = JSON.parse(formData.config);
      if (editingId) {
        // PUT scopes by the row's own workspace; only create needs the id.
        await apiPut(`/mcp-servers/${editingId}`, { ...formData, config });
      } else {
        await apiPost("/mcp-servers", {
          ...formData,
          config,
          workspaceId: activeWorkspaceId,
        });
      }
      setShowForm(false);
      setEditingId(null);
      setFormData({
        name: "",
        transportType: "stdio",
        config: DEFAULT_STDIO_CONFIG,
        isEnabled: true,
      });
      loadServers();
    } catch (err) {
      setFormError(
        err instanceof Error ? err.message : "Failed to save server",
      );
    }
  };

  const handleDelete = async (id: number) => {
    try {
      await apiDelete(`/mcp-servers/${id}`);
      setDeleteError(null);
      setServers((s) => s.filter((srv) => srv.id !== id));
      setDeleteConfirmId(null);
    } catch (err) {
      // The confirm UI stays open on failure, so the alert below plus
      // another Confirm press is the full announce-and-retry path.
      setDeleteError(
        err instanceof Error ? err.message : "Failed to delete server",
      );
    }
  };

  const handleEdit = (server: McpServer) => {
    setFormData({
      name: server.name,
      transportType: server.transportType,
      config: JSON.stringify(server.configJson, null, 2),
      isEnabled: server.isEnabled,
    });
    setEditingId(server.id);
    setShowForm(true);
  };

  const handleProbe = async (server: McpServer) => {
    setProbeState((prev) => ({
      ...prev,
      [server.id]: { status: "running" },
    }));
    try {
      const result = await apiPost<{
        ok: boolean;
        tools?: Array<{ name: string }>;
        error?: string;
      }>(`/mcp-servers/${server.id}/probe`);
      if (result.ok) {
        const count = result.tools?.length ?? 0;
        setProbeState((prev) => ({
          ...prev,
          [server.id]: {
            status: "ok",
            detail: count === 0 ? "Connected (no tools)" : `${count} tools`,
          },
        }));
      } else {
        setProbeState((prev) => ({
          ...prev,
          [server.id]: {
            status: "error",
            detail: result.error || "Probe failed",
          },
        }));
      }
    } catch (err) {
      setProbeState((prev) => ({
        ...prev,
        [server.id]: {
          status: "error",
          detail: err instanceof Error ? err.message : "Probe failed",
        },
      }));
    }
  };

  if (showForm) {
    return (
      <div className="mx-auto max-w-2xl">
        <div
          className="rounded-lg border p-6"
          style={{ borderColor: COLORS.cardBorder, backgroundColor: COLORS.bg }}
        >
          <div className="mb-4 flex items-center justify-between">
            <h2
              className="text-lg font-semibold"
              style={{ color: COLORS.textPrimary }}
            >
              {editingId ? "Edit MCP Server" : "Add MCP Server"}
            </h2>
            <button
              onClick={closeForm}
              aria-label="Close MCP server form"
              className="hover:opacity-80"
              style={{ color: COLORS.textSecondary }}
            >
              <X className="h-5 w-5" aria-hidden="true" />
            </button>
          </div>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label
                htmlFor="mcp-server-name"
                className="block text-sm font-medium"
                style={{ color: COLORS.textSecondary }}
              >
                Name
              </label>
              <input
                id="mcp-server-name"
                required
                type="text"
                value={formData.name}
                onChange={(e) =>
                  setFormData({ ...formData, name: e.target.value })
                }
                className="mt-1 block w-full rounded-lg border px-3 py-2 text-sm focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500"
                style={{
                  borderColor: COLORS.border,
                  backgroundColor: COLORS.inputBg,
                  color: COLORS.textPrimary,
                }}
              />
            </div>
            <div>
              <label
                htmlFor="mcp-transport-type"
                className="block text-sm font-medium"
                style={{ color: COLORS.textSecondary }}
              >
                Transport Type
              </label>
              <select
                id="mcp-transport-type"
                value={formData.transportType}
                onChange={(e) => {
                  const transportType = e.target.value as TransportType;
                  setFormData((prev) => {
                    const blank =
                      prev.config.trim() === "" || prev.config.trim() === "{}";
                    let config = prev.config;
                    if (
                      blank ||
                      prev.config === DEFAULT_STDIO_CONFIG ||
                      prev.config === DEFAULT_HTTP_CONFIG
                    ) {
                      config =
                        transportType === "stdio"
                          ? DEFAULT_STDIO_CONFIG
                          : DEFAULT_HTTP_CONFIG;
                    }
                    return { ...prev, transportType, config };
                  });
                }}
                className="mt-1 block w-full rounded-lg border px-3 py-2 text-sm focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500"
                style={{
                  borderColor: COLORS.border,
                  backgroundColor: COLORS.inputBg,
                  color: COLORS.textPrimary,
                }}
              >
                <option value="stdio">stdio</option>
                <option value="sse">SSE</option>
                <option value="streamable-http">Streamable HTTP</option>
              </select>
              {formData.transportType !== "stdio" && (
                <p
                  className="mt-1 text-xs"
                  style={{ color: COLORS.textSecondary }}
                >
                  Set <code className="font-mono">url</code> to the MCP endpoint
                  (SSE GET URL or streamable-http POST URL). Optional{" "}
                  <code className="font-mono">headers</code> are forwarded.
                </p>
              )}
            </div>
            <div>
              <label
                htmlFor="mcp-config-json"
                className="block text-sm font-medium"
                style={{ color: COLORS.textSecondary }}
              >
                Config (JSON)
              </label>
              <textarea
                id="mcp-config-json"
                required
                rows={6}
                value={formData.config}
                onChange={(e) =>
                  setFormData({ ...formData, config: e.target.value })
                }
                className="mt-1 block w-full rounded-lg border px-3 py-2 font-mono text-sm focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500"
                style={{
                  borderColor: COLORS.border,
                  backgroundColor: COLORS.inputBg,
                  color: COLORS.textPrimary,
                }}
              />
              {formData.transportType === "stdio" && (
                <p
                  className="mt-1 text-xs"
                  style={{ color: COLORS.textSecondary }}
                >
                  Requires <code className="font-mono">command</code> (and
                  optional <code className="font-mono">args</code>,{" "}
                  <code className="font-mono">cwd</code>,{" "}
                  <code className="font-mono">env</code>). Test runs tools/list
                  over stdio.
                </p>
              )}
            </div>
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="isEnabled"
                checked={formData.isEnabled}
                onChange={(e) =>
                  setFormData({ ...formData, isEnabled: e.target.checked })
                }
                className="rounded text-primary-600 focus:ring-primary-500"
                style={{ borderColor: COLORS.border }}
              />
              <label
                htmlFor="isEnabled"
                className="text-sm"
                style={{ color: COLORS.textSecondary }}
              >
                Enabled
              </label>
            </div>
            {formError && (
              <p
                role="alert"
                className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300"
              >
                {formError}
              </p>
            )}
            <div className="flex justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={closeForm}
                className="rounded-lg border px-4 py-2 text-sm font-medium hover:opacity-80"
                style={{
                  borderColor: COLORS.border,
                  color: COLORS.textSecondary,
                  backgroundColor: COLORS.hoverBg,
                }}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-primary-950 hover:bg-primary-700"
              >
                {editingId ? "Update" : "Add"} Server
              </button>
            </div>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <div className="flex items-center justify-between">
        <h2
          className="text-lg font-semibold"
          style={{ color: COLORS.textPrimary }}
        >
          MCP Servers
        </h2>
        <button
          onClick={() => {
            setFormData({
              name: "",
              transportType: "stdio",
              config: DEFAULT_STDIO_CONFIG,
              isEnabled: true,
            });
            setEditingId(null);
            setShowForm(true);
          }}
          className="flex items-center gap-2 rounded-lg bg-primary-600 px-3 py-2 text-sm font-medium text-primary-950 hover:bg-primary-700"
        >
          <Plus className="h-4 w-4" /> Add Server
        </button>
      </div>
      <p className="text-sm" style={{ color: COLORS.textSecondary }}>
        Test runs tools/list for stdio, SSE, and streamable-http. Successful
        probes feed chat tool rounds.
      </p>
      {deleteError && (
        <p
          role="alert"
          className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300"
        >
          Couldn&apos;t delete server: {deleteError}
        </p>
      )}
      {isLoading ? (
        <LoadingIndicator label="Loading MCP servers" />
      ) : loadError && servers.length === 0 ? (
        <EmptyState
          alert
          icon={Server}
          title="Couldn't load MCP servers"
          description={loadError}
          action={
            <button
              onClick={loadServers}
              className="rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-primary-950 hover:bg-primary-700"
            >
              Retry
            </button>
          }
        />
      ) : servers.length === 0 ? (
        <EmptyState
          icon={Server}
          title="No MCP servers configured"
          description="Add a server (stdio command or HTTP url), then use Test to list tools."
        />
      ) : (
        <div className="space-y-3">
          {servers.map((server) => (
            <div
              key={server.id}
              className="flex items-center justify-between rounded-lg border p-4"
              style={{
                borderColor: COLORS.cardBorder,
                backgroundColor: COLORS.bg,
              }}
            >
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-1.5" role="status">
                  {server.isEnabled ? (
                    <CheckCircle2
                      className="h-4 w-4 text-emerald-500"
                      aria-hidden="true"
                    />
                  ) : (
                    <CircleX
                      className="h-4 w-4"
                      style={{ color: COLORS.textSecondary }}
                      aria-hidden="true"
                    />
                  )}
                  <span
                    className="text-xs font-medium"
                    style={{ color: COLORS.textSecondary }}
                  >
                    {server.isEnabled ? "Enabled" : "Disabled"}
                  </span>
                </div>
                <div>
                  <h3
                    className="font-medium"
                    style={{ color: COLORS.textPrimary }}
                  >
                    {server.name}
                  </h3>
                  <span
                    className="text-xs"
                    style={{ color: COLORS.textSecondary }}
                  >
                    {server.transportType}
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-2">
                {deleteConfirmId === server.id ? (
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => {
                        void handleDelete(server.id);
                      }}
                      className="rounded px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950"
                    >
                      Confirm
                    </button>
                    <button
                      onClick={() => setDeleteConfirmId(null)}
                      className="rounded px-2 py-1 text-xs font-medium hover:opacity-80"
                      style={{
                        color: COLORS.textSecondary,
                        backgroundColor: COLORS.hoverBg,
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={() => void handleProbe(server)}
                      disabled={probeState[server.id]?.status === "running"}
                      aria-label={`Test ${server.name}`}
                      className="max-w-[14rem] truncate rounded px-2 py-1 text-xs font-medium min-h-11 hover:opacity-80 disabled:opacity-50"
                      style={{
                        color:
                          probeState[server.id]?.status === "error"
                            ? "#b91c1c"
                            : COLORS.textSecondary,
                        border: `1px solid ${COLORS.border}`,
                      }}
                      title={
                        probeState[server.id]?.detail ??
                        `Run tools/list over ${server.transportType}`
                      }
                    >
                      {probeButtonLabel(probeState[server.id])}
                    </button>
                    <button
                      onClick={() => handleEdit(server)}
                      aria-label={`Edit ${server.name}`}
                      className="flex min-h-11 min-w-11 items-center justify-center rounded p-1 hover:text-primary-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
                      style={{ color: COLORS.textSecondary }}
                    >
                      <Settings className="h-4 w-4" />
                    </button>
                    <button
                      onClick={() => setDeleteConfirmId(server.id)}
                      aria-label={`Delete ${server.name}`}
                      className="flex min-h-11 min-w-11 items-center justify-center rounded p-1 hover:text-red-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500"
                      style={{ color: COLORS.textSecondary }}
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
