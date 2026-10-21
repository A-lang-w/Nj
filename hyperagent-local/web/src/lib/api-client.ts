const BASE = "/api";

/**
 * HTTP failures carry their status so callers can distinguish auth rejection
 * (401: the server refused the session) from transport failure (a bare
 * TypeError with no status). Message handling is unchanged.
 */
export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/** Dispatched when the server definitively rejects the session (401/403 on
 * refresh) — not on network throws or 5xx, which say nothing about the
 * session. App.tsx listens and ends the session with an explanation. */
export const SESSION_EXPIRED_EVENT = "auth:session-expired";

// SEC-011: Automatic token refresh on 401. When a request fails with 401,
// we attempt to refresh the JWT via /auth/refresh. If refresh succeeds,
// the original request is retried once with the new cookie. A concurrent
// refresh is deduplicated so multiple failing requests share one refresh call.
let refreshPromise: Promise<boolean> | null = null;

/**
 * Shared, deduped session refresh. Exported so non-fetch transports (SSE)
 * can renew the cookie through the same in-flight call as API requests.
 */
export async function refreshSessionToken(): Promise<boolean> {
  return refreshToken();
}

async function refreshToken(): Promise<boolean> {
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    const attempt = () =>
      fetch(`${BASE}/auth/refresh`, {
        method: "POST",
        credentials: "include",
      });
    try {
      const res = await attempt();
      if (res.ok) return true;
      if (res.status === 401 || res.status === 403) {
        // Lost-race retry: another tab may have rotated first, leaving the
        // winner's fresh cookie in the shared jar. The server answers a
        // consumed jti with 401 WITHOUT clearing (src/routes/auth.ts), so
        // retry once against the current cookie before declaring dead.
        const retry = await attempt().catch(() => null);
        if (retry && retry.ok) return true;
        // No cookie at all is the logged-out bootstrap path, not mid-session
        // expiry — announcing expiry would flash "session ended" on every
        // cold visit to /login.
        let absentCookie = false;
        try {
          const body = (await res.json()) as { error?: unknown };
          absentCookie = body.error === "No session token";
        } catch {
          absentCookie = false;
        }
        if (!absentCookie) {
          window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT));
        }
      }
      return false;
    } catch {
      return false;
    } finally {
      refreshPromise = null;
    }
  })();
  return refreshPromise;
}

/**
 * Render a parsed error body as a human-readable string. String envelopes
 * pass through; Zod `{ error: { issues } }` shapes join to "path: message"
 * lines; anything else stringifies rather than rendering "[object Object]".
 * Shared by handleResponse and streamApiPost so both surface the same text.
 */
function extractErrorMessage(parsed: unknown, fallback: string): string {
  if (typeof parsed === "object" && parsed !== null && "error" in parsed) {
    const err = (parsed as { error: unknown }).error;
    if (typeof err === "string" && err) return err;
    if (err !== undefined && err !== null) {
      const issues = (
        err as { issues?: Array<{ message?: unknown; path?: unknown }> }
      ).issues;
      if (Array.isArray(issues) && issues.length > 0) {
        return issues
          .map((issue) => {
            const path = Array.isArray(issue.path)
              ? issue.path.join(".")
              : null;
            const text =
              typeof issue.message === "string"
                ? issue.message
                : "Invalid value";
            return path ? `${path}: ${text}` : text;
          })
          .join("; ");
      }
      return JSON.stringify(err);
    }
  }
  return fallback;
}

async function handleResponse<T>(
  response: Response,
  url: string,
  init?: RequestInit,
): Promise<T> {
  // SEC-011: On 401, attempt a token refresh and retry the request once.
  if (response.status === 401 && init !== undefined) {
    const refreshed = await refreshToken();
    if (refreshed) {
      const retryResponse = await fetch(url, init);
      if (retryResponse.ok || retryResponse.status !== 401) {
        return handleResponse<T>(retryResponse, url);
      }
    }
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    let message = `Request failed: ${response.status}`;
    try {
      message = extractErrorMessage(JSON.parse(body), message);
    } catch {
      if (body) message = body;
    }
    throw new ApiError(message, response.status);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

function buildUrl(
  path: string,
  params?: Record<string, string | number | boolean | undefined>,
): string {
  const url = new URL(`${BASE}${path}`, window.location.origin);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
  }
  return url.pathname + url.search;
}

export async function apiGet<T>(
  path: string,
  params?: Record<string, string | number | boolean | undefined>,
): Promise<T> {
  const url = buildUrl(path, params);
  const init: RequestInit = { credentials: "include" };
  const response = await fetch(url, init);
  return handleResponse<T>(response, url, init);
}

export async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  const url = `${BASE}${path}`;
  const init: RequestInit = {
    method: "POST",
    credentials: "include",
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  };
  const response = await fetch(url, init);
  return handleResponse<T>(response, url, init);
}

export async function apiPut<T>(path: string, body: unknown): Promise<T> {
  const url = `${BASE}${path}`;
  const init: RequestInit = {
    method: "PUT",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
  const response = await fetch(url, init);
  return handleResponse<T>(response, url, init);
}

export async function apiPatch<T>(path: string, body: unknown): Promise<T> {
  const url = `${BASE}${path}`;
  const init: RequestInit = {
    method: "PATCH",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
  const response = await fetch(url, init);
  return handleResponse<T>(response, url, init);
}

export async function apiDelete(path: string): Promise<void> {
  const url = `${BASE}${path}`;
  const init: RequestInit = {
    method: "DELETE",
    credentials: "include",
  };
  const response = await fetch(url, init);
  return handleResponse<void>(response, url, init);
}

/**
 * Streaming POST request that returns the raw Response so callers can
 * consume `response.body` as a ReadableStream. Applies the same base URL,
 * credentials, and 401-refresh semantics as the rest of the api-client.
 * Throws on non-ok responses after refresh attempts.
 */
export async function streamApiPost(
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<Response> {
  const url = `${BASE}${path}`;
  const init: RequestInit = {
    method: "POST",
    credentials: "include",
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal,
  };

  let response = await fetch(url, init);

  // SEC-011: Mirror the token-refresh retry used by handleResponse.
  if (response.status === 401) {
    const refreshed = await refreshToken();
    if (refreshed) {
      response = await fetch(url, init);
    }
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    let message = `Request failed: ${response.status}`;
    try {
      message = extractErrorMessage(JSON.parse(text), message);
    } catch {
      if (text) message = text;
    }
    throw new ApiError(message, response.status);
  }

  return response;
}
