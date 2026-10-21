import { describe, expect, it } from "vitest";

import { decodeKeyedArchiveBytes } from "./KeyedArchiveReader.js";
import {
  decodeBinaryPlistDates,
  resolveBinaryPlistDates,
  scanBinaryPlistDates,
} from "./PlistDateLiterals.js";
import {
  binaryKeyedArchiveWithDateSeconds,
  binaryKeyedArchiveWithUnidentifiedDate,
  dateMarkerBytes,
} from "../../../tests/fixtures/keyedArchiveDates.js";

const decode = (seconds: readonly number[]) =>
  decodeKeyedArchiveBytes(binaryKeyedArchiveWithDateSeconds(seconds), {
    offset: 0,
    limit: 20,
  });

describe("binary plist date precision", () => {
  it("keeps the source instant of a date finer than a millisecond", () => {
    const graph = decode([0.1005]);

    expect(graph.objects[1]?.value).toEqual({
      $plist_type: "date",
      iso8601: "2001-01-01T00:00:00.100500Z",
    });
    expect(graph.limitations).toContainEqual(
      expect.stringContaining(
        "1 date value(s) carry source precision finer than a millisecond",
      ),
    );
  });

  it("keeps a whole-millisecond date at millisecond precision", () => {
    const graph = decode([0.1]);

    expect(graph.objects[1]?.value).toEqual({
      $plist_type: "date",
      iso8601: "2001-01-01T00:00:00.100Z",
    });
    expect(graph.limitations).not.toContainEqual(
      expect.stringContaining("date value(s) carry source precision"),
    );
  });

  it("follows source objects rather than rounded values", () => {
    const graph = decode([0.1005, 0.1006]);

    expect(graph.objects.map(({ value }) => value)).toEqual([
      "$null",
      { $plist_type: "date", iso8601: "2001-01-01T00:00:00.100500Z" },
      { $plist_type: "date", iso8601: "2001-01-01T00:00:00.100600Z" },
    ]);
  });

  it("reports a non-finite source date as an unknown timestamp", () => {
    const graph = decode([Number.NaN]);

    expect(graph.objects[1]?.value).toEqual({
      $plist_type: "date",
      iso8601: null,
    });
    expect(graph.limitations).toContainEqual(
      expect.stringContaining(
        '1 date value(s) are reported as { "$plist_type": "date", "iso8601": null }',
      ),
    );
  });

  it("identifies a date whose marker is not the canonical date marker", () => {
    const bytes = binaryKeyedArchiveWithDateSeconds([0.1005]);
    bytes[bytes.indexOf(0x33)] = 0x30;

    const graph = decodeKeyedArchiveBytes(bytes, { offset: 0, limit: 20 });

    expect(graph.objects[1]?.value).toEqual({
      $plist_type: "date",
      iso8601: "2001-01-01T00:00:00.100500Z",
    });
  });

  it("does not rewrite dates in a structure it cannot establish", () => {
    const bytes = binaryKeyedArchiveWithDateSeconds([0.1005]);
    const metadata = scanBinaryPlistDates(bytes);

    expect(metadata.incomplete).toBe(false);
    expect(metadata.dates).toHaveLength(1);
    expect(decodeBinaryPlistDates(bytes, metadata)).not.toBe(bytes);
    expect(bytes.subarray(0, 8).toString("ascii")).toBe("bplist00");
  });

  it("reports a decoded date without a source object as an unknown instant", () => {
    const metadata = scanBinaryPlistDates(
      binaryKeyedArchiveWithDateSeconds([0.1005]),
    );

    expect(resolveBinaryPlistDates({ value: new Date(0) }, metadata)).toEqual({
      value: new Date(Number.NaN),
    });
  });

  it("keeps the source marker of a date object", () => {
    const bytes = binaryKeyedArchiveWithDateSeconds([0.1005]);

    expect(dateMarkerBytes(bytes, 0)).toBe(0x33);
  });

  it("discloses an archive whose date identity is not established", () => {
    const bytes = binaryKeyedArchiveWithUnidentifiedDate();

    expect(scanBinaryPlistDates(bytes)).toEqual({
      dates: [],
      incomplete: true,
    });
    const graph = decodeKeyedArchiveBytes(bytes, { offset: 0, limit: 20 });
    expect(graph.limitations).toContainEqual(
      expect.stringContaining(
        "Date identity could not be established for every date object",
      ),
    );
    expect(graph.limitations).not.toContainEqual(
      expect.stringContaining("date value(s) carry source precision"),
    );
  });
});
