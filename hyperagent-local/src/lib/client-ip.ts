import { config } from "../config.js";

// SEC-006: Resolve client IP for rate limiting.
// When trustProxy is false (default), uses the socket remote address to prevent
// bypass via spoofable x-forwarded-for / x-real-ip headers. Only trusts forwarded
// headers when explicitly configured behind a known reverse proxy.

interface RawRequestWithSocket extends Request {
  socket?: { remoteAddress?: string };
}

export function resolveClientIp(c: {
  req: { raw: Request; header: (name: string) => string | undefined };
}): string {
  if (!config.trustProxy) {
    return (
      (c.req.raw as RawRequestWithSocket).socket?.remoteAddress || "127.0.0.1"
    );
  }
  return (
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
    c.req.header("x-real-ip") ??
    "127.0.0.1"
  );
}
