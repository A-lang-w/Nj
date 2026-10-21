import { describe, it, expect } from "vitest";
import { nextPrimeWorkspaceId } from "../../web/src/lib/prime-workspace";

/**
 * Sidebar priming policy: the recent-threads list is primed at most once
 * per workspace while empty. Depending on the store's loading/error flags
 * re-enters the effect after every completed empty fetch (isLoading flips
 * true then false with the list still empty), issuing GET /threads forever
 * until the rate limiter 429s and painting a false load error.
 *
 * The suite has no component renderer, so the effect's decision is a pure
 * helper tested here; the effect itself only calls the helper and fetches
 * when it returns a workspace id.
 */
describe("nextPrimeWorkspaceId", () => {
  it("primes an unprimed workspace while the list is empty", () => {
    expect(nextPrimeWorkspaceId(null, 1, 0)).toBe(1);
  });

  it("does not re-prime after a completed empty fetch", () => {
    // The completed-empty state (list still [], loading false again) is
    // what re-entered the old flag-dependent effect and looped forever.
    expect(nextPrimeWorkspaceId(1, 1, 0)).toBeNull();
  });

  it("does not prime when the list already has threads", () => {
    expect(nextPrimeWorkspaceId(null, 1, 5)).toBeNull();
  });

  it("primes again after a workspace change", () => {
    expect(nextPrimeWorkspaceId(1, 2, 0)).toBe(2);
  });
});
