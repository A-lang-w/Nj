// SEC-012: Shared in-memory rate limiter factory for local-only single-user tool.
// Counters reset on process restart, which means a restarted server briefly allows
// a fresh burst of attempts. To mitigate this, a startup grace period rejects all
// requests for the first few seconds after process start, preventing immediate burst
// abuse on restart. Persisting rate-limit state to SQLite would add write contention
// on every request for marginal security gain in this threat model. If the tool ever
// gains network accessibility or multi-user support, replace this Map with a durable store.

/** Default startup grace period in milliseconds. */
const DEFAULT_STARTUP_GRACE_MS = 5_000;

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

export interface RateLimiterOptions {
  /** Time window in milliseconds before the counter resets. */
  windowMs: number;
  /** Maximum number of allowed attempts within the window. */
  maxAttempts: number;
  /**
   * Duration in milliseconds after process start during which all requests are rejected.
   * Prevents burst abuse immediately after a restart. Defaults to 5000ms.
   * Set to 0 to disable the startup grace period.
   */
  startupGraceMs?: number;
}

export interface RateLimiter {
  /** Returns true if the request is allowed, false if rate-limited. */
  check: (key: string) => boolean;
}

/**
 * Creates an independent rate limiter instance with its own backing store.
 * Each call returns a self-contained limiter suitable for a specific route
 * or middleware scope (e.g., auth login vs. general API).
 */
export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const isTestEnv =
    process.env.VITEST === "true" || process.env.NODE_ENV === "test";
  const defaultGraceMs = isTestEnv ? 0 : DEFAULT_STARTUP_GRACE_MS;
  const { windowMs, maxAttempts, startupGraceMs = defaultGraceMs } = options;
  const store = new Map<string, RateLimitEntry>();
  const startedAt = Date.now();

  return {
    check(key: string): boolean {
      const now = Date.now();

      // Reject all requests during the startup grace period to prevent burst abuse on restart.
      if (startupGraceMs > 0 && now - startedAt < startupGraceMs) {
        return false;
      }

      const entry = store.get(key);

      if (!entry || now >= entry.resetAt) {
        store.set(key, { count: 1, resetAt: now + windowMs });
        return true;
      }

      if (entry.count >= maxAttempts) {
        return false;
      }

      entry.count++;
      return true;
    },
  };
}
