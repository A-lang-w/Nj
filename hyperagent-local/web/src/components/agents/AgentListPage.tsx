import { useCallback, useEffect, useMemo, useState } from "react";
import { useAgentsStore } from "@/stores/agents-store";
import { useUiStore } from "@/stores/ui-store";
import { useFavoritesStore } from "@/stores/favorites-store";
import { AgentCard } from "./AgentCard";
import { AgentForm } from "./AgentForm";
import { Plus, Search, Bot } from "lucide-react";
import { LoadingIndicator } from "@/components/ui/LoadingIndicator";
import { EmptyState } from "@/components/ui/EmptyState";
import { COLORS } from "@/lib/theme-colors";

type AgentScope = "all" | "starred" | "personal" | "community";

export function AgentListPage() {
  const agents = useAgentsStore((s) => s.agents);
  const fetchAgents = useAgentsStore((s) => s.fetchAgents);
  const isLoading = useAgentsStore((s) => s.isLoading);
  const fetchError = useAgentsStore((s) => s.fetchError);
  const fetchFavorites = useFavoritesStore((s) => s.fetchFavorites);
  const favoriteKeys = useFavoritesStore((s) => s.keys);
  const activeWorkspaceId = useUiStore((s) => s.activeWorkspaceId);
  const [searchTerm, setSearchTerm] = useState("");
  const [scope, setScope] = useState<AgentScope>("all");
  const [showForm, setShowForm] = useState(false);
  // Stable close callback: AgentForm's focus effect depends on onClose, so an
  // inline closure would re-run it on every parent re-render — yanking focus
  // back to the first field mid-typing and recapturing the restore target.
  const closeForm = useCallback(() => setShowForm(false), []);

  useEffect(() => {
    fetchAgents(activeWorkspaceId);
    void fetchFavorites();
  }, [fetchAgents, fetchFavorites, activeWorkspaceId]);

  const filtered = useMemo(
    () =>
      agents.filter((a) => {
        if (scope === "starred" && !favoriteKeys.has(`agent:${a.id}`))
          return false;
        if (scope === "personal" && a.isCommunity) return false;
        if (scope === "community" && !a.isCommunity) return false;
        if (!searchTerm) return true;
        return a.name.toLowerCase().includes(searchTerm.toLowerCase());
      }),
    [agents, searchTerm, scope, favoriteKeys],
  );

  return (
    <div className="flex h-full flex-col">
      <div
        className="flex items-center justify-between border-b px-6"
        style={{
          height: "104px",
          boxSizing: "border-box",
          borderColor: COLORS.border,
        }}
      >
        <h1 className="text-xl font-bold" style={{ color: COLORS.textPrimary }}>
          Agents
        </h1>
        <button
          onClick={() => setShowForm(true)}
          className="flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium"
          style={{
            backgroundColor: COLORS.activeBg,
            color: COLORS.textPrimary,
          }}
        >
          <Plus className="h-4 w-4" /> New agent
        </button>
      </div>

      <div
        className="flex items-center gap-3 border-b px-6 py-3"
        style={{ borderColor: COLORS.border }}
      >
        <div className="relative flex-1 max-w-md">
          <Search
            className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2"
            style={{ color: COLORS.textSecondary }}
          />
          <input
            type="text"
            placeholder="Search agents…"
            aria-label="Search agents"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full rounded-lg border py-2 pl-9 pr-3 text-sm min-h-[44px] focus:outline-none focus:ring-1"
            style={{
              borderColor: COLORS.border,
              backgroundColor: COLORS.inputBg,
              color: COLORS.textPrimary,
            }}
          />
        </div>
        <label htmlFor="agent-scope-filter" className="sr-only">
          Filter agents
        </label>
        <select
          id="agent-scope-filter"
          value={scope}
          onChange={(e) => setScope(e.target.value as AgentScope)}
          className="rounded-lg border px-3 py-2 text-sm min-h-[44px]"
          style={{
            borderColor: COLORS.border,
            backgroundColor: COLORS.inputBg,
            color: COLORS.textPrimary,
          }}
        >
          <option value="all">All agents</option>
          <option value="starred">Starred</option>
          <option value="personal">Personal</option>
          <option value="community">Community</option>
        </select>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        {isLoading ? (
          <LoadingIndicator label="Loading agents" />
        ) : fetchError && agents.length === 0 ? (
          <EmptyState
            alert
            icon={Bot}
            title="Couldn't load agents"
            description={fetchError}
            action={
              <button
                onClick={() => fetchAgents(activeWorkspaceId)}
                className="rounded px-4 py-2"
                style={{
                  backgroundColor: COLORS.activeBg,
                  color: COLORS.textPrimary,
                }}
              >
                Retry
              </button>
            }
          />
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={Bot}
            title="No agents yet"
            action={
              <button
                onClick={() => setShowForm(true)}
                className="rounded px-4 py-2"
                style={{
                  backgroundColor: COLORS.activeBg,
                  color: COLORS.textPrimary,
                }}
              >
                Create your first agent
              </button>
            }
          />
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {filtered.map((agent) => (
              <AgentCard key={agent.id} agent={agent} />
            ))}
          </div>
        )}
      </div>

      {showForm && <AgentForm onClose={closeForm} />}
    </div>
  );
}
