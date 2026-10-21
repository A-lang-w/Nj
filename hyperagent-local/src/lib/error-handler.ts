import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { logger } from "./logger.js";

/**
 * Shared application error handler, installed via `app.onError` in index.ts
 * and in route-contract tests so both exercise the same code path.
 *
 * - Malformed request bodies are client errors: SyntaxError from direct
 *   `c.req.json()` calls (routes should prefer readJsonBody, but this
 *   backstop closes the class) and HTTPException(400) from Hono's validator
 *   on zValidator routes both render the documented 400 `{ error }`
 *   envelope. The message matches Hono's validator wording so direct-parse
 *   and validator-parse failures are indistinguishable to clients.
 * - All other throws keep Hono's default 500-text behavior. In particular,
 *   HTTPException statuses are preserved — a blanket 500 here would turn
 *   the validator's 400s into 500s.
 */
export function handleAppError(err: Error, c: Context): Response {
  if (err instanceof SyntaxError) {
    return c.json({ error: "Malformed JSON in request body" }, 400);
  }
  if (err instanceof HTTPException) {
    return c.json({ error: err.message }, err.status);
  }
  logger.error("Unhandled application error", { error: err });
  return c.text("Internal Server Error", 500);
}
