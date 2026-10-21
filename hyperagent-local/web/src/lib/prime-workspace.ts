/**
 * Sidebar thread-list priming policy.
 *
 * The sidebar primes the recent-threads list when it mounts on a page that
 * never fetched threads (e.g. a cold load of /memories). The prime must run
 * at most once per workspace while the list is empty: depending on the
 * store's loading/error flags re-enters the effect after every completed
 * empty fetch (isLoading flips true then false with the list still empty),
 * refetching GET /threads forever until the rate limiter 429s and painting
 * a false load error.
 *
 * Pure so the no-reprime-after-empty-fetch invariant is unit-testable — the
 * suite has no component renderer. The caller holds `primedWorkspaceId` in
 * a ref, calls this in the effect, and fetches only when it returns a
 * workspace id.
 *
 * @returns the workspace to fetch, or null when no fetch is needed.
 */
export function nextPrimeWorkspaceId(
  primedWorkspaceId: number | null,
  activeWorkspaceId: number,
  threadCount: number,
): number | null {
  if (primedWorkspaceId === activeWorkspaceId) return null;
  if (threadCount > 0) return null;
  return activeWorkspaceId;
}
