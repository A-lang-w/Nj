/**
 * Validate that a plain object does not exceed depth or total key limits.
 *
 * Depth counts nesting levels: `{}` is depth 1, `{a:{}}` is depth 2, etc.
 * Arrays and non-objects are rejected. Nested arrays are not walked further
 * as object children (only plain nested objects contribute depth/keys).
 *
 * @param value - Candidate value (must be a plain object).
 * @param label - Field name used in error messages (e.g. `"config"`, `"settings"`).
 * @param maxDepth - Maximum nesting depth inclusive.
 * @param maxKeys - Maximum total keys across all nested objects.
 */
export function validateBoundedObject(
  value: unknown,
  label: string,
  maxDepth: number,
  maxKeys: number,
): { ok: true } | { ok: false; error: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, error: `${label} must be a plain object` };
  }
  let totalKeys = 0;
  function walk(
    obj: Record<string, unknown>,
    depth: number,
  ): { ok: true } | { ok: false; error: string } {
    if (depth > maxDepth) {
      return {
        ok: false,
        error: `${label} nesting exceeds ${maxDepth} levels`,
      };
    }
    const keys = Object.keys(obj);
    for (const k of keys) {
      totalKeys += 1;
      if (totalKeys > maxKeys) {
        return {
          ok: false,
          error: `${label} has too many keys (max ${maxKeys})`,
        };
      }
      const v = obj[k];
      if (typeof v === "object" && v !== null && !Array.isArray(v)) {
        const inner = walk(v as Record<string, unknown>, depth + 1);
        if (!inner.ok) return inner;
      }
    }
    return { ok: true };
  }
  return walk(value as Record<string, unknown>, 1);
}
