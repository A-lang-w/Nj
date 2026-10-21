import {
  createPlistNumberCollector,
  type PlistNumberLiterals,
} from "../../domain/apple/plistNumbers.js";
import { scanBinaryPlistObjectTable } from "./BinaryPlistObjectTable.js";

export interface BinaryPlistNumberMetadata {
  readonly literals: PlistNumberLiterals;
  /** 16-byte integers the pinned plist decoder cannot decode correctly. */
  readonly wideIntegers: readonly { offset: number; value: bigint }[];
}

const binaryObjectEnd = (
  bytes: Buffer,
  offset: number,
  objectEnd: number,
  referenceWidth: number,
): number | undefined => {
  const marker = bytes[offset];
  if (marker === undefined) return undefined;
  const type = marker >> 4;
  let length = marker & 0x0f;
  let cursor = offset + 1;
  if (length === 0x0f && type !== 0 && type !== 8) {
    const extendedMarker = bytes[cursor];
    if (extendedMarker === undefined || extendedMarker >> 4 !== 1)
      return undefined;
    const width = 1 << (extendedMarker & 0x0f);
    if (width > 8 || cursor + 1 + width > objectEnd) return undefined;
    cursor += 1;
    let extendedLength = 0n;
    for (let index = 0; index < width; index += 1)
      extendedLength =
        (extendedLength << 8n) | BigInt(bytes[cursor + index] ?? 0);
    if (extendedLength > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
    length = Number(extendedLength);
    cursor += width;
  }
  let payloadLength: number;
  if (type === 0) payloadLength = 0;
  else if (type === 1 || type === 2) {
    if ((marker & 0x0f) > 4) return undefined;
    payloadLength = 1 << (marker & 0x0f);
  } else if (type === 3) {
    if (marker !== 0x33) return undefined;
    payloadLength = 8;
  } else if (type === 4 || type === 5 || type === 7) {
    payloadLength = length;
  } else if (type === 6) {
    payloadLength = length * 2;
  } else if (type === 8) {
    payloadLength = (marker & 0x0f) + 1;
  } else if (type === 10 || type === 11 || type === 12) {
    payloadLength = length * referenceWidth;
  } else if (type === 13) {
    payloadLength = length * 2 * referenceWidth;
  } else return undefined;
  const end = cursor + payloadLength;
  return Number.isSafeInteger(end) && end <= objectEnd ? end : undefined;
};

/** Observe bounded binary number markers without changing primary decode acceptance. */
export const scanBinaryPlistNumberLiterals = (
  bytes: Buffer,
): BinaryPlistNumberMetadata => {
  const output = createPlistNumberCollector();
  const wideIntegers: { offset: number; value: bigint }[] = [];
  const table = scanBinaryPlistObjectTable(bytes);
  if (table === undefined)
    return { literals: output.result(true), wideIntegers };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const referenceWidth = table.referenceWidth;
  const offsetTable = table.objectsEnd;
  const objectOffsets = table.objects.map((object) => object.offset);
  const sortedOffsets = [...new Set(objectOffsets)].sort((a, b) => a - b);
  for (let index = 0; index < sortedOffsets.length; index += 1) {
    const offset = sortedOffsets[index];
    if (offset === undefined) continue;
    const nextOffset = sortedOffsets[index + 1] ?? offsetTable;
    if (
      binaryObjectEnd(bytes, offset, nextOffset, referenceWidth) === undefined
    )
      return { literals: output.result(true), wideIntegers: [] };
  }
  for (const offset of objectOffsets) {
    const marker = bytes[offset] ?? 0;
    const type = marker >> 4;
    if (type !== 1 && type !== 2) continue;
    const width = 2 ** (marker & 0xf);
    if (offset + 1 + width > offsetTable)
      return { literals: output.result(true), wideIntegers };
    if (type === 1 && width === 8) output.integer(view.getBigInt64(offset + 1));
    else if (type === 1 && width === 16) {
      const value = BigInt.asIntN(
        128,
        (view.getBigUint64(offset + 1) << 64n) | view.getBigUint64(offset + 9),
      );
      output.integer(value);
      wideIntegers.push({ offset, value });
    } else if (type === 1 && width > 4)
      return { literals: output.result(true), wideIntegers };
    else if (type === 2 && width === 4)
      output.real(view.getFloat32(offset + 1));
    else if (type === 2 && width === 8)
      output.real(view.getFloat64(offset + 1));
    else if (type === 2) return { literals: output.result(true), wideIntegers };
  }
  return { literals: output.result(), wideIntegers };
};

/** Preserve 16-byte integers through plist@5's Number-only parser. */
export const decodeBinaryPlistNumbers = (
  bytes: Buffer,
  metadata: BinaryPlistNumberMetadata,
): Buffer => {
  if (metadata.wideIntegers.length === 0) return bytes;
  const compatible = Buffer.from(bytes);
  for (const { offset, value } of metadata.wideIntegers) {
    // Convert only the decoder's input copy to a double. Exact integer metadata
    // from the original bytes restores decimal text after the structural parse.
    compatible[offset] = 0x23;
    compatible.writeDoubleBE(Number(value), offset + 1);
  }
  return compatible;
};
