import { useThreadsStore } from "@/stores/threads-store";
import { useAgentsStore } from "@/stores/agents-store";
import { useInboxStore } from "@/stores/inbox-store";

/**
 * Clear every session-scoped client store at an account boundary: login (the
 * /login route has no authed-redirect, so a signed-in user can switch
 * accounts without logging out), logout, and session expiry.
 *
 * Without this, the next account's first paint reads the previous account's
 * lists from the global stores — and a failed refetch leaves them on screen,
 * because the fetchers deliberately keep stale data on error so a
 * same-account blip never drops good data. Worse, small-integer thread ids
 * collide across accounts, so opening /threads/1 can render the previous
 * account's messages until the new fetch settles.
 *
 * Synchronous and ordered before the `user` state change at each call site,
 * so no render can observe the new user with the old account's data. Device
 * preferences (layout, filters, workspace selection) are intentionally kept.
 */
export function resetSessionStores(): void {
  useThreadsStore.getState().resetAccountData();
  useAgentsStore.getState().resetAccountData();
  useInboxStore.getState().resetAccountData();
}
