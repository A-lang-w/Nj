/**
 * A property-list date whose source instant carries precision finer than a
 * millisecond. Binary property lists store Float64 seconds, so the source
 * instant of a date is not limited to the millisecond resolution of a
 * JavaScript Date.
 */
export class PrecisePlistDate {
  constructor(
    /** Whole milliseconds since 1970-01-01T00:00:00Z. */
    readonly epochMilliseconds: number,
    /** Microseconds within the millisecond, 0-999. */
    readonly microsecondRemainder: number,
  ) {}
}

/** Limitation for dates reported with microsecond precision. */
export const preciseDateLimitation = (count: number): string =>
  `${String(count)} date value(s) carry source precision finer than a millisecond and are reported with microsecond precision; the original archive bytes retain the exact source seconds.`;

/** Limitation for archives whose date objects could not be identified. */
export const incompleteDateLimitation =
  "Date identity could not be established for every date object, so dates are reported with millisecond resolution; the original archive bytes retain the source seconds.";

/**
 * Render the instant as an ISO 8601 UTC timestamp. Milliseconds are reported
 * when the instant is a whole millisecond, and microsecond digits are added
 * when the source carried finer precision.
 */
export const formatPlistDateIso = (
  epochMilliseconds: number,
  microsecondRemainder: number,
): string | undefined => {
  const date = new Date(epochMilliseconds);
  if (!Number.isFinite(Date.prototype.getTime.call(date))) return undefined;
  const iso = Date.prototype.toISOString.call(date);
  if (microsecondRemainder === 0) return iso;
  return iso.replace(
    /(\.\d{3})Z$/u,
    `$1${String(microsecondRemainder).padStart(3, "0")}Z`,
  );
};
