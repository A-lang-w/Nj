import { create } from "zustand";
import { apiGet, apiPost, apiDelete } from "@/lib/api-client";

export type FavoriteTargetType = "thread" | "agent" | "skill" | "memory";

export interface Favorite {
  targetType: FavoriteTargetType;
  targetId: number;
}

function favoriteKey(type: FavoriteTargetType, id: number): string {
  return `${type}:${id}`;
}

interface FavoritesState {
  keys: Set<string>;
  isLoading: boolean;
  fetchFavorites: () => Promise<void>;
  isFavorite: (type: FavoriteTargetType, id: number) => boolean;
  toggleFavorite: (type: FavoriteTargetType, id: number) => Promise<void>;
  resetAccountData: () => void;
}

let sessionGeneration = 0;

export const useFavoritesStore = create<FavoritesState>((set, get) => {
  let fetchRequestId = 0;

  return {
    keys: new Set(),
    isLoading: false,

    fetchFavorites: async () => {
      const requestId = ++fetchRequestId;
      set({ isLoading: true });
      try {
        const response = await apiGet<{
          items: Array<{ targetType: string; targetId: number }>;
        }>("/favorites");
        if (fetchRequestId !== requestId) return;
        const next = new Set<string>();
        for (const item of response.items) {
          if (
            item.targetType === "thread" ||
            item.targetType === "agent" ||
            item.targetType === "skill" ||
            item.targetType === "memory"
          ) {
            next.add(favoriteKey(item.targetType, item.targetId));
          }
        }
        set({ keys: next, isLoading: false });
      } catch {
        if (fetchRequestId === requestId) {
          set({ isLoading: false });
        }
      }
    },

    isFavorite: (type, id) => get().keys.has(favoriteKey(type, id)),

    toggleFavorite: async (type, id) => {
      const generation = sessionGeneration;
      const key = favoriteKey(type, id);
      const wasFavorite = get().keys.has(key);
      // Optimistic update so stars feel instant across lists.
      set((s) => {
        const next = new Set(s.keys);
        if (wasFavorite) next.delete(key);
        else next.add(key);
        return { keys: next };
      });
      try {
        if (wasFavorite) {
          await apiDelete(`/favorites?targetType=${type}&targetId=${id}`);
        } else {
          await apiPost("/favorites", { targetType: type, targetId: id });
        }
      } catch (err) {
        if (generation === sessionGeneration) {
          set((s) => {
            const next = new Set(s.keys);
            if (wasFavorite) next.add(key);
            else next.delete(key);
            return { keys: next };
          });
        }
        throw err;
      }
    },

    resetAccountData: () => {
      fetchRequestId++;
      sessionGeneration++;
      set({ keys: new Set(), isLoading: false });
    },
  };
});
