import { hasBinaryPlistSignature } from "../../domain/apple/appleArchiveFormat.js";

/** One object of a binary property list, as the offset table records it. */
export interface BinaryPlistObject {
  /** Byte offset of the object marker. */
  readonly offset: number;
  /** Marker byte, which carries the object type and its length. */
  readonly marker: number;
  /** Object type nibble of the marker. */
  readonly type: number;
}

/** The object table of a binary property list. */
export interface BinaryPlistObjectTable {
  /** Objects in table order; an index may repeat an earlier offset. */
  readonly objects: readonly BinaryPlistObject[];
  /** Exclusive end of the object area, where the offset table starts. */
  readonly objectsEnd: number;
  /** Reference width in bytes, as the trailer records it. */
  readonly referenceWidth: number;
}

/**
 * Read the object table of a binary property list. The trailer and the offset
 * table are the only source of object identity, so every consumer of binary
 * property-list bytes reads them here. A structure that is not established
 * returns undefined rather than a partial table.
 */
export const scanBinaryPlistObjectTable = (
  bytes: Buffer,
): BinaryPlistObjectTable | undefined => {
  if (bytes.length < 40 || !hasBinaryPlistSignature(bytes)) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const trailer = bytes.length - 32;
  const offsetWidth = bytes[trailer + 6] ?? 0;
  if (![1, 2, 4, 8].includes(offsetWidth)) return undefined;
  const countRaw = view.getBigUint64(trailer + 8);
  const tableRaw = view.getBigUint64(trailer + 24);
  const safeMaximum = BigInt(Number.MAX_SAFE_INTEGER);
  if (countRaw === 0n || countRaw > safeMaximum || tableRaw > safeMaximum)
    return undefined;
  if (tableRaw < 8n || tableRaw >= BigInt(trailer)) return undefined;
  const offsetTable = Number(tableRaw);
  const capacity = Math.floor((trailer - offsetTable) / offsetWidth);
  if (countRaw > BigInt(capacity)) return undefined;
  const count = Number(countRaw);
  const referenceWidth = bytes[trailer + 7] ?? 0;
  if (![1, 2, 4, 8].includes(referenceWidth)) return undefined;
  const unsigned = (offset: number): number | undefined => {
    if (offset < offsetTable || offset + offsetWidth > trailer)
      return undefined;
    if (offsetWidth === 1) return view.getUint8(offset);
    if (offsetWidth === 2) return view.getUint16(offset);
    if (offsetWidth === 4) return view.getUint32(offset);
    const value = view.getBigUint64(offset);
    return value > safeMaximum ? undefined : Number(value);
  };
  const objects: BinaryPlistObject[] = [];
  for (let index = 0; index < count; index += 1) {
    const offset = unsigned(offsetTable + index * offsetWidth);
    if (offset === undefined || offset < 8 || offset >= offsetTable)
      return undefined;
    const marker = bytes[offset] ?? 0;
    objects.push({ offset, marker, type: marker >> 4 });
  }
  return { objects, objectsEnd: offsetTable, referenceWidth };
};
