/**
 * Milliseconds between 1970-01-01 and 2001-01-01.
 * Matches plist@5 `parse-binary.js` `EPOCH_2001`.
 */
const APPLE_REFERENCE_EPOCH_MILLISECONDS = 978_307_200_000;

/**
 * Whether plist@5's `new Date(seconds * 1000 + epoch)` denotes the same
 * float64 seconds. Each source payload is judged on its own; distinct
 * instants can share one rounded millisecond.
 */
export const binaryPlistDateRepresentable = (seconds: number): boolean => {
  if (!Number.isFinite(seconds)) return false;
  const decoded = new Date(seconds * 1000 + APPLE_REFERENCE_EPOCH_MILLISECONDS);
  const time = Date.prototype.getTime.call(decoded);
  if (!Number.isFinite(time)) return false;
  return (time - APPLE_REFERENCE_EPOCH_MILLISECONDS) / 1000 === seconds;
};

/**
 * Give the pinned decoder an Invalid Date for each payload it cannot
 * represent. The caller's buffer stays unchanged; a copy is returned only
 * when a payload changes.
 */
export const maskUnrepresentableBinaryPlistDates = (
  bytes: Buffer,
  payloadOffsets: readonly number[],
): Buffer => {
  if (payloadOffsets.length === 0) return bytes;
  let copy: Buffer | undefined;
  for (const offset of payloadOffsets) {
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset + 8 > bytes.length
    )
      throw new TypeError("binary plist date object is truncated");
    if (binaryPlistDateRepresentable(bytes.readDoubleBE(offset))) continue;
    copy ??= Buffer.from(bytes);
    copy.writeDoubleBE(Number.NaN, offset);
  }
  return copy ?? bytes;
};
