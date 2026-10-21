import type { Context } from "hono";
import type { ZodError } from "zod";

/**
 * Shared `zValidator` hook rendering schema failures in the uniform
 * `{ error: string }` envelope.
 *
 * The library default (`c.json(result, 400)`) returns the raw safeParse
 * result `{ success: false, error: ZodError }`, bypassing `onError` and
 * breaking the string-envelope contract every other route honors. This
 * hook joins the issues to one `"; "`-separated `"path: message"` string —
 * the same rendering `extractErrorMessage` in `web/src/lib/api-client.ts`
 * applies, kept there for back-compat with already-shipped responses.
 */
export function zodEnvelopeHook(
  result:
    | { success: true; data: unknown }
    | { success: false; error: ZodError },
  c: Context,
): Response | void {
  if (result.success) return;
  const issues = result.error.issues ?? [];
  const message =
    issues.length > 0
      ? issues
          .map((issue) => {
            const path = Array.isArray(issue.path)
              ? issue.path.join(".")
              : null;
            const text =
              typeof issue.message === "string" && issue.message
                ? issue.message
                : "Invalid value";
            return path ? `${path}: ${text}` : text;
          })
          .join("; ")
      : "Invalid request body";
  return c.json({ error: message }, 400);
}
