import { buildBinary } from "plist";
import { expect } from "vitest";

import { keyedArchiveResultSchema } from "../../src/domain/apple/keyedArchive.js";

/** Seconds between 1970-01-01 and the 2001 reference date of binary property lists. */
export const EPOCH_2001_SECONDS = 978307200;

/** Read one object-table offset of the given width. */
const readOffset = (bytes: Buffer, offset: number, width: number): number => {
  if (width === 1) return bytes.readUInt8(offset);
  if (width === 2) return bytes.readUInt16BE(offset);
  if (width === 4) return bytes.readUInt32BE(offset);
  return Number(bytes.readBigUInt64BE(offset));
};

/** Write one object-table offset of the given width. */
const writeOffset = (
  bytes: Buffer,
  offset: number,
  width: number,
  value: number,
): void => {
  if (width === 1) bytes.writeUInt8(value, offset);
  else if (width === 2) bytes.writeUInt16BE(value, offset);
  else if (width === 4) bytes.writeUInt32BE(value, offset);
  else bytes.writeBigUInt64BE(BigInt(value), offset);
};

/** Byte offsets of the date objects in a binary property list. */
const dateObjectOffsets = (bytes: Buffer): number[] => {
  const trailer = bytes.length - 32;
  const offsetWidth = bytes[trailer + 6] ?? 0;
  const count = Number(bytes.readBigUInt64BE(trailer + 8));
  const offsetTable = Number(bytes.readBigUInt64BE(trailer + 24));
  const offsets: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const offset = readOffset(
      bytes,
      offsetTable + index * offsetWidth,
      offsetWidth,
    );
    if ((bytes[offset] ?? 0) >> 4 === 3) offsets.push(offset);
  }
  return offsets;
};

/**
 * Build a binary keyed archive whose date objects carry exact source seconds.
 * A property-list builder can only write whole milliseconds, so the source
 * Float64 payload is written into the built archive.
 */
export const binaryKeyedArchiveWithDateSeconds = (
  seconds: readonly number[],
): Buffer => {
  const bytes = Buffer.from(
    buildBinary({
      $archiver: "NSKeyedArchiver",
      $version: 100000,
      $objects: [
        "$null",
        ...seconds.map(() => new Date(EPOCH_2001_SECONDS * 1000)),
      ],
      $top: Object.fromEntries(
        seconds.map((_, index) => [`root${String(index)}`, { UID: index + 1 }]),
      ),
    }),
  );
  const offsets = dateObjectOffsets(bytes);
  seconds.forEach((value, index) => {
    const offset = offsets[index];
    if (offset === undefined) throw new Error("Expected a date object");
    bytes.writeDoubleBE(value, offset + 1);
  });
  return bytes;
};

/** The marker byte of a date object, which the decoder reads as a date. */
export const dateMarkerBytes = (bytes: Buffer, index: number): number => {
  const offset = dateObjectOffsets(bytes)[index];
  if (offset === undefined) throw new Error("Expected a date object");
  return bytes[offset] ?? 0;
};

/**
 * A binary keyed archive whose date object cannot be identified. The object
 * table entry of the date points at the trailer, so the source payload is not
 * readable and no date of the archive keeps a rewritten identity.
 */
export const binaryKeyedArchiveWithUnidentifiedDate = (): Buffer => {
  const bytes = binaryKeyedArchiveWithDateSeconds([0.1005]);
  const trailer = bytes.length - 32;
  const offsetWidth = bytes[trailer + 6] ?? 1;
  const count = Number(bytes.readBigUInt64BE(trailer + 8));
  const offsetTable = Number(bytes.readBigUInt64BE(trailer + 24));
  const dateOffset = dateObjectOffsets(bytes)[0];
  if (dateOffset === undefined) throw new Error("Expected a date object");
  for (let index = 0; index < count; index += 1) {
    const entry = offsetTable + index * offsetWidth;
    if (readOffset(bytes, entry, offsetWidth) !== dateOffset) continue;
    writeOffset(bytes, entry, offsetWidth, trailer);
  }
  return bytes;
};

/** A reported binary keyed archive whose object 1 holds one date. */
export interface ReportedDateArchive {
  readonly name: string;
  /** The reported archive bytes. */
  readonly base64: string;
  /** Digest of the reported archive bytes. */
  readonly sha256: string;
  /** The instant the archive carries after the 2001 reference date. */
  readonly seconds: number;
  /** The timestamp the archive reports for that instant. */
  readonly iso8601: string;
  /** Whether the instant is finer than a millisecond. */
  readonly precise: boolean;
}

/**
 * Binary keyed archives reported with a sub-millisecond date. The bytes are
 * the reported fixtures: one canonical millisecond date, one whose marker the
 * decoder still reads as a date, and one with a sub-millisecond instant.
 */
export const reportedDateArchives: readonly ReportedDateArchive[] = [
  {
    name: "canonical",
    base64:
      "YnBsaXN0MDDUAQIDBAUGCQxZJGFyY2hpdmVyWCRvYmplY3RzVCR0b3BYJHZlcnNpb25fEA9OU0tleWVkQXJjaGl2ZXKiBwhVJG51bGwzP7mZmZmZmZrRCgtUcm9vdIABEgABhqAIERskKTJER01WWV5gAAAAAAAAAQEAAAAAAAAADQAAAAAAAAAAAAAAAAAAAGU=",
    sha256: "39f08db8341bd74220352dfd559485515cce1e6035e08f27a59ab8f856374a30",
    seconds: 0.1,
    iso8601: "2001-01-01T00:00:00.100Z",
    precise: false,
  },
  {
    name: "non-canonical-marker",
    base64:
      "YnBsaXN0MDDUAQIDBAUGCQxZJGFyY2hpdmVyWCRvYmplY3RzVCR0b3BYJHZlcnNpb25fEA9OU0tleWVkQXJjaGl2ZXKiBwhVJG51bGwwP7mZmZmZmZrRCgtUcm9vdIABEgABhqAIERskKTJER01WWV5gAAAAAAAAAQEAAAAAAAAADQAAAAAAAAAAAAAAAAAAAGU=",
    sha256: "ac5696b866c312feb53c2e82edd8fea79dbeb572eb1b07e4291603faa41e8c0e",
    seconds: 0.1,
    iso8601: "2001-01-01T00:00:00.100Z",
    precise: false,
  },
  {
    name: "sub-millisecond",
    base64:
      "YnBsaXN0MDDUAQIDBAUGCQxZJGFyY2hpdmVyWCRvYmplY3RzVCR0b3BYJHZlcnNpb25fEA9OU0tleWVkQXJjaGl2ZXKiBwhVJG51bGwzP7m6XjU/fO7RCgtUcm9vdIABEgABhqAIERskKTJER01WWV5gAAAAAAAAAQEAAAAAAAAADQAAAAAAAAAAAAAAAAAAAGU=",
    sha256: "ab69ba6e8034c6f60b828ee323a5a3e81bae3e7657477e0ebfbfdb93d53ed2ce",
    seconds: 0.1005,
    iso8601: "2001-01-01T00:00:00.100500Z",
    precise: true,
  },
];

/** The reported archive bytes. */
export const reportedDateArchiveBytes = (
  archive: ReportedDateArchive,
): Buffer => Buffer.from(archive.base64, "base64");

/** Require the source instant of a reported archive and its precision notice. */
export const expectKeyedArchiveDatePrecision = (
  value: unknown,
  archive: ReportedDateArchive,
) => {
  const result = keyedArchiveResultSchema.parse(value);
  expect(result.archive_sha256).toBe(archive.sha256);
  expect(
    result.objects.map(({ id, kind, value: object }) => ({
      id,
      kind,
      value: object,
    })),
  ).toEqual([
    { id: 0, kind: "nil", value: "$null" },
    {
      id: 1,
      kind: "scalar",
      value: { $plist_type: "date", iso8601: archive.iso8601 },
    },
  ]);
  if (archive.precise)
    expect(result.limitations).toContainEqual(
      expect.stringMatching(
        /^1 date value\(s\) carry source precision finer than a millisecond/u,
      ),
    );
  else
    expect(result.limitations).not.toContainEqual(
      expect.stringContaining("date value(s) carry source precision"),
    );
};
