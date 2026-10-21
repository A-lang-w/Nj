import type { Context } from "hono";
import { Ok, Err, ValidationError, type Result } from "./result.js";

/**
 * Parse the request body as JSON, modelling malformed input with the tagged
 * error algebra instead of Hono's default 500-text throw.
 *
 * `c.req.json()` rejects with a SyntaxError on malformed bodies; without this
 * guard the request escapes to the shared error handler. Callers map `Err`
 * to 400 with the same message the backstop uses, so both paths agree.
 *
 * Valid JSON is not necessarily an object: `null`, arrays, and scalars
 * parse fine, but every caller dereferences fields — so `null` threw a
 * TypeError (500) and `[]` slipped through as all-fields-absent (a silent
 * default thread on POST /threads, a no-op settings bump). Non-objects
 * are rejected here, once, for all callers.
 */
export async function readJsonBody<T = Record<string, unknown>>(
  c: Context,
): Promise<Result<T, ValidationError>> {
  let value: unknown;
  try {
    value = (await c.req.json()) as T;
  } catch {
    return Err(new ValidationError("Malformed JSON in request body"));
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return Err(new ValidationError("Request body must be an object"));
  }
  return Ok(value as T);
}
