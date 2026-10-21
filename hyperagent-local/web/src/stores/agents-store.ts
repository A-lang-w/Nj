import { create } from "zustand";
import type { Agent } from "@/types/api";
import { apiGet, apiPost, apiPut, apiDelete } from "@/lib/api-client";

interface AgentsState {
  agents: Agent[];
  isLoading: boolean;
  fetchError: string | null;
  fetchAgents: (workspaceId?: number) => Promise<void>;
  createAgent: (agent: Partial<Agent>) => Promise<Agent>;
  updateAgent: (id: number, agent: Partial<Agent>) => Promise<Agent>;
  deleteAgent: (id: number) => Promise<void>;
  /** Drop all account-owned state at a session boundary. */
  resetAccountData: () => void;
}

// Session generation: resetAccountData bumps it so a mutation started under
// the previous account cannot write when it resolves late. Same-account
// behavior is unchanged — the generation only moves on reset.
let sessionGeneration = 0;

export const useAgentsStore = create<AgentsState>((set) => {
  // Staleness guard: overlapping fetches resolve in arbitrary order, so only
  // the latest request may write results or clear the loading state.
  let fetchRequestId = 0;

  return {
    agents: [],
    isLoading: false,
    fetchError: null,

    fetchAgents: async (workspaceId?: number) => {
      const requestId = ++fetchRequestId;
      set({ isLoading: true, fetchError: null });
      try {
        const response = await apiGet<{ items: Agent[]; total: number }>(
          "/agents",
          workspaceId !== undefined ? { workspaceId } : undefined,
        );
        if (fetchRequestId !== requestId) return;
        set({ agents: response.items, isLoading: false });
      } catch (err) {
        if (fetchRequestId === requestId) {
          set({
            isLoading: false,
            fetchError:
              err instanceof Error ? err.message : "Failed to load agents",
          });
        }
      }
    },

    createAgent: async (agent) => {
      const generation = sessionGeneration;
      const created = await apiPost<Agent>("/agents", agent);
      if (generation === sessionGeneration)
        set((s) => ({ agents: [created, ...s.agents] }));
      return created;
    },

    updateAgent: async (id, agent) => {
      const generation = sessionGeneration;
      const updated = await apiPut<Agent>(`/agents/${id}`, agent);
      // Small ids collide across accounts: without the generation check the
      // previous account's update would overwrite the new account's same-id row.
      if (generation === sessionGeneration) {
        set((s) => ({
          agents: s.agents.map((a) => (a.id === id ? updated : a)),
        }));
      }
      return updated;
    },

    deleteAgent: async (id) => {
      const generation = sessionGeneration;
      await apiDelete(`/agents/${id}`);
      // Same collision: a pre-reset delete must not remove the new account's
      // same-id row (the server delete was already correctly scoped).
      if (generation === sessionGeneration) {
        set((s) => ({ agents: s.agents.filter((a) => a.id !== id) }));
      }
    },

    resetAccountData: () => {
      // Invalidate in-flight requests: their responses belong to the previous
      // account (the fetchRequestId guard already drops stale fetch writes).
      fetchRequestId++;
      sessionGeneration++;
      set({ agents: [], isLoading: false, fetchError: null });
    },
  };
});
