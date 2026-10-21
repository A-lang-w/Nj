/**
 * Clamp a pagination parameter to a safe integer range.
 *
 * Floors the input to an integer and clamps it between 0 and `max`.
 * If `value` is NaN, non-finite, or negative, returns `defaultVal` instead.
 *
 * @param value - Raw pagination input (typically from a query string).
 * @param defaultVal - Fallback returned when `value` is NaN, non-finite, or negative.
 * @param max - Upper bound (inclusive) for the clamped result.
 * @returns A non-negative integer at most `max`, or `defaultVal` on invalid input.
 */
export function clampPagination(
  value: unknown,
  defaultVal: number,
  max: number,
): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return defaultVal;
  return Math.min(Math.max(0, Math.floor(n)), max);
}
