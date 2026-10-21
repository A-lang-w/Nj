import { create } from "zustand";
import type { User } from "@/types/api";
import { ApiError, apiPost, apiGet } from "@/lib/api-client";
import { useUiStore } from "@/stores/ui-store";
import { resetSessionStores } from "@/lib/session-reset";

/** Shown on /login when a previously valid session ended. */
export const SESSION_EXPIRED_MESSAGE =
  "Your session ended. Please sign in again.";

interface AuthState {
  user: User | null;
  isLoading: boolean;
  /** Why the user landed on /login mid-session; null for fresh visitors. */
  sessionExpiredReason: string | null;
  login: (email: string) => Promise<void>;
  logout: () => Promise<void>;
  checkSession: () => Promise<void>;
}

export const useAuthStore = create<AuthState>((set, get) => {
  // Staleness guard: a slow session check must not overwrite a newer login
  // result (or vice versa) when the two overlap.
  let sessionRequestId = 0;

  return {
    user: null,
    isLoading: true,
    sessionExpiredReason: null,
    login: async (email: string) => {
      const requestId = ++sessionRequestId;
      set({ isLoading: true });
      try {
        const response = await apiPost<{ user: User; workspaceId: number }>(
          "/auth/login",
          { email },
        );
        if (sessionRequestId !== requestId) return;
        // /login has no authed-redirect: a signed-in user can switch accounts
        // here, so drop the previous account's lists before the new user
        // paints, or its first paint shows stale titles and messages.
        resetSessionStores();
        set({
          user: response.user,
          isLoading: false,
          sessionExpiredReason: null,
        });
        // Adopt the provisioned workspace: a brand-new account owns neither
        // workspace 1 nor any stale stored id, so keeping the old value
        // would 404 every data page with no recovery.
        useUiStore.getState().setActiveWorkspace(response.workspaceId);
      } catch (err) {
        if (sessionRequestId === requestId) set({ isLoading: false });
        // Preserve the server's message (notably the 429 "wait before trying
        // again" guidance): a generic rewrite invites a blind retry loop.
        throw err instanceof Error ? err : new Error("Login failed");
      }
    },
    logout: async () => {
      sessionRequestId++;
      await apiPost("/auth/logout");
      // Leave no account data for the next login's first paint.
      resetSessionStores();
      set({ user: null, sessionExpiredReason: null });
    },
    checkSession: async () => {
      const requestId = ++sessionRequestId;
      set({ isLoading: true });
      // Only a user who HAD a session gets an expiry explanation; a fresh
      // visitor with no session is the normal logged-out path, not an error.
      const hadUser = get().user !== null;
      const expiredReason = hadUser ? SESSION_EXPIRED_MESSAGE : null;
      try {
        const [sessionResponse, userResponse] = await Promise.all([
          apiGet<{ active: boolean }>("/auth/sessions"),
          apiGet<User>("/settings/user").catch((err: unknown) => {
            // Only an auth rejection means the profile is gone. A network
            // throw or 5xx says nothing about the session: mark it transient
            // (undefined) so a live session survives a blip on this request,
            // mirroring the 401/403-only rule in the catch below.
            if (
              err instanceof ApiError &&
              (err.status === 401 || err.status === 403)
            )
              return null;
            return undefined;
          }),
        ]);
        if (sessionRequestId !== requestId) return;
        if (sessionResponse.active) {
          // Self-heal a stale stored workspace (fresh login on another
          // device, cleared storage, deleted workspace): without this the
          // client asks for an unowned id and 404s every data page with no
          // recovery. Best-effort — failure keeps the stored id and pages
          // surface their own load errors with Retry.
          try {
            const owned =
              await apiGet<Array<{ id: number; name: string }>>("/workspaces");
            if (sessionRequestId !== requestId) return;
            const ownedIds = owned.map((w) => w.id);
            const current = useUiStore.getState().activeWorkspaceId;
            if (!ownedIds.includes(current) && ownedIds.length > 0) {
              useUiStore.getState().setActiveWorkspace(ownedIds[0]);
            }
          } catch {
            if (sessionRequestId !== requestId) return;
          }
        }
        if (sessionResponse.active && userResponse) {
          set({
            user: userResponse,
            isLoading: false,
            sessionExpiredReason: null,
          });
        } else if (sessionResponse.active && userResponse === undefined) {
          set({ isLoading: false });
        } else {
          resetSessionStores();
          set({
            user: null,
            isLoading: false,
            sessionExpiredReason: expiredReason,
          });
        }
      } catch (err) {
        if (sessionRequestId !== requestId) return;
        // Only a definitive auth rejection ends the session. A network throw
        // or 5xx says nothing about the session: ending it here would bounce
        // a mid-session user to /login with a false "expired" story on every
        // transient blip. Those keep the current user and clear loading only.
        if (
          !(err instanceof ApiError) ||
          (err.status !== 401 && err.status !== 403)
        ) {
          set({ isLoading: false });
          return;
        }
        // A returning visitor whose cookie the server rejects (401 after the
        // refresh attempt already failed inside handleResponse) gets the same
        // explanation as a mid-session expiry. A fresh visitor (no cookie)
        // does not. The cookie is httpOnly so document.cookie cannot probe
        // for it; instead read the middleware's distinction (src/auth/
        // middleware.ts): 'Unauthorized' is emitted only when no cookie was
        // presented, while every other 401 means a session existed and died.
        const cookieRejected = err.message !== "Unauthorized";
        resetSessionStores();
        set({
          user: null,
          isLoading: false,
          sessionExpiredReason:
            hadUser || cookieRejected ? SESSION_EXPIRED_MESSAGE : null,
        });
      }
    },
  };
});
