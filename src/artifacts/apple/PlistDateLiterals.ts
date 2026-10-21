import { PrecisePlistDate } from "../../domain/apple/plistDate.js";
import { scanBinaryPlistObjectTable } from "./BinaryPlistObjectTable.js";

/** Milliseconds between 1970-01-01 and the 2001 reference date of binary property lists. */
const EPOCH_2001_MILLISECONDS = 978307200000;
/** Microseconds between 1970-01-01 and the 2001 reference date. */
const EPOCH_2001_MICROSECONDS = 978307200000000;

/** One date object of a binary property list. */
export interface BinaryPlistDate {
  /** Byte offset of the date marker in the source archive. */
  readonly offset: number;
  /** Seconds after the 2001 reference date, as the source Float64 payload. */
  readonly seconds: number;
}

/** Date objects observed in a binary property list. */
export interface BinaryPlistDateMetadata {
  /** Date objects in object-table order, one entry per distinct object. */
  readonly dates: readonly BinaryPlistDate[];
  /**
   * Date identity could not be established for every date object, so no date
   * is rewritten and no source instant is claimed for any of them.
   */
  readonly incomplete: boolean;
}

/**
 * Observe the date objects of a binary property list. The pinned decoder
 * builds a JavaScript Date from the Float64 seconds, which truncates the
 * source instant to whole milliseconds, so the source payloads are read here
 * and kept against their own objects.
 */
export const scanBinaryPlistDates = (
  bytes: Buffer,
): BinaryPlistDateMetadata => {
  const table = scanBinaryPlistObjectTable(bytes);
  if (table === undefined) return { dates: [], incomplete: true };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dates: BinaryPlistDate[] = [];
  const observed = new Set<number>();
  for (const object of table.objects) {
    // The pinned decoder reads every type 3 object as a date, whatever its
    // length nibble says, so date identity follows the same rule.
    if (object.type !== 3) continue;
    if (observed.has(object.offset)) continue;
    observed.add(object.offset);
    // A date object without a complete payload has no source instant to
    // establish, so no date of the archive keeps a rewritten identity.
    if (object.offset + 9 > table.objectsEnd)
      return { dates: [], incomplete: true };
    dates.push({
      offset: object.offset,
      seconds: view.getFloat64(object.offset + 1),
    });
  }
  return { dates, incomplete: false };
};

/**
 * Prepare decoder input so that each date identifies its own source object.
 * The sentinel replaces the source seconds in the decoder's copy of the bytes;
 * the original archive keeps the source values.
 */
export const decodeBinaryPlistDates = (
  bytes: Buffer,
  metadata: BinaryPlistDateMetadata,
): Buffer => {
  if (metadata.dates.length === 0) return bytes;
  const compatible = Buffer.from(bytes);
  metadata.dates.forEach((date, index) => {
    // A non-finite source stays an invalid date, which the decoder reports as
    // an unknown timestamp rather than a sentinel.
    if (!Number.isFinite(date.seconds)) return;
    compatible.writeDoubleBE(index + 1, date.offset + 1);
  });
  return compatible;
};

/** The source instant of a date object, at microsecond resolution. */
const preciseDate = (seconds: number): PrecisePlistDate => {
  const microseconds = Math.round(seconds * 1e6) + EPOCH_2001_MICROSECONDS;
  const epochMilliseconds = Math.floor(microseconds / 1000);
  return new PrecisePlistDate(
    epochMilliseconds,
    microseconds - epochMilliseconds * 1000,
  );
};

/** The sentinel index of a decoded date, when it carries one. */
const sentinelIndex = (date: Date): number | undefined => {
  const time = Date.prototype.getTime.call(date);
  if (!Number.isFinite(time)) return undefined;
  const offset = time - EPOCH_2001_MILLISECONDS;
  if (offset <= 0 || offset % 1000 !== 0) return undefined;
  return offset / 1000 - 1;
};

/** A decoded value that can hold further values. */
const isContainer = (value: unknown): value is Record<string, unknown> =>
  value !== null &&
  typeof value === "object" &&
  !(value instanceof Date) &&
  !(value instanceof Uint8Array);

/**
 * Replace the decoder's millisecond dates with the source instants. The
 * decoded tree belongs to the caller, so the dates are replaced in place. A
 * date whose source object is not established becomes an explicit unknown
 * rather than a known instant that the source never carried.
 */
export const resolveBinaryPlistDates = (
  value: unknown,
  metadata: BinaryPlistDateMetadata,
): unknown => {
  if (metadata.dates.length === 0) return value;
  const resolve = (date: Date): Date | PrecisePlistDate => {
    if (Number.isNaN(Date.prototype.getTime.call(date))) return date;
    const index = sentinelIndex(date);
    if (index === undefined) return new Date(Number.NaN);
    const source = metadata.dates[index];
    return source === undefined
      ? new Date(Number.NaN)
      : preciseDate(source.seconds);
  };
  let root = value;
  if (root instanceof Date) root = resolve(root);
  const pending: unknown[] = root instanceof Date ? [] : [root];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) continue;
    if (Array.isArray(current)) {
      for (let index = 0; index < current.length; index += 1) {
        const child = current[index];
        if (child instanceof Date) current[index] = resolve(child);
        else if (isContainer(child) || Array.isArray(child))
          pending.push(child);
      }
      continue;
    }
    if (!isContainer(current)) continue;
    for (const key of Object.keys(current)) {
      const child = current[key];
      if (child instanceof Date) current[key] = resolve(child);
      else if (isContainer(child) || Array.isArray(child)) pending.push(child);
    }
  }
  return root;
};
