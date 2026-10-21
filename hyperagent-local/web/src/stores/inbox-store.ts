import { create } from "zustand";
import type { InboxSummary, ActivityEvent } from "@/types/api";
import { apiGet } from "@/lib/api-client";
import { useUiStore } from "@/stores/ui-store";

interface InboxState {
  summary: InboxSummary | null;
  activity: ActivityEvent[];
  isLoading: boolean;
  fetchError: string | null;
  fetchSummary: () => Promise<void>;
  fetchActivity: (limit?: number) => Promise<void>;
  /** Drop all account-owned state at a session boundary. */
  resetAccountData: () => void;
}

export const useInboxStore = create<InboxState>((set) => {
  // Staleness guard: polling + manual refreshes overlap, so only the latest
  // request per fetcher may write.
  let summaryRequestId = 0;
  let activityRequestId = 0;

  return {
    summary: null,
    activity: [],
    isLoading: false,
    fetchError: null,
    fetchSummary: async () => {
      const requestId = ++summaryRequestId;
      try {
        // Always send the signed-in workspace; omitting it asks the server
        // for the caller's personal workspace, which may not be the active one.
        const workspaceId = useUiStore.getState().activeWorkspaceId;
        const summary = await apiGet<InboxSummary>("/inbox/summary", {
          workspaceId,
        });
        if (summaryRequestId !== requestId) return;
        set({ summary });
      } catch {
        // Silently fail for polling
      }
    },
    fetchActivity: async (limit = 50) => {
      const requestId = ++activityRequestId;
      set({ isLoading: true, fetchError: null });
      try {
        const workspaceId = useUiStore.getState().activeWorkspaceId;
        const activity = await apiGet<ActivityEvent[]>("/inbox/activity", {
          workspaceId,
          limit,
        });
        if (activityRequestId !== requestId) return;
        set({ activity, isLoading: false });
      } catch (err) {
        if (activityRequestId === requestId) {
          set({
            isLoading: false,
            fetchError:
              err instanceof Error ? err.message : "Failed to load inbox",
          });
        }
      }
    },

    resetAccountData: () => {
      // Invalidate in-flight fetches: their responses belong to the previous
      // account (the per-fetcher id guards already drop stale writes).
      summaryRequestId++;
      activityRequestId++;
      set({ summary: null, activity: [], isLoading: false, fetchError: null });
    },
  };
});
