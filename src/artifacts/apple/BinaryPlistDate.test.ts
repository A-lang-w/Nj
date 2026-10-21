import { describe, expect, it } from "vitest";

import {
  binaryPlistDateRepresentable,
  maskUnrepresentableBinaryPlistDates,
} from "./BinaryPlistDate.js";

describe("binary plist date instants", () => {
  it("keeps canonical millisecond encodings and rejects nearby floats", () => {
    expect(binaryPlistDateRepresentable(0.1)).toBe(true);
    expect(binaryPlistDateRepresentable(0)).toBe(true);
    expect(binaryPlistDateRepresentable(0.001)).toBe(true);
    expect(binaryPlistDateRepresentable(-0)).toBe(true);
    expect(binaryPlistDateRepresentable(0.1005)).toBe(false);
    expect(binaryPlistDateRepresentable(0.1004)).toBe(false);
    const next = Buffer.alloc(8);
    next.writeDoubleBE(0.1);
    next.writeBigUInt64BE(next.readBigUInt64BE(0) + 1n);
    expect(binaryPlistDateRepresentable(next.readDoubleBE(0))).toBe(false);
    expect(binaryPlistDateRepresentable(Number.NaN)).toBe(false);
    expect(binaryPlistDateRepresentable(Number.POSITIVE_INFINITY)).toBe(false);
  });

  it("rewrites only unrepresentable payloads and leaves the source buffer intact", () => {
    const bytes = Buffer.alloc(18);
    bytes[0] = 0x33;
    bytes.writeDoubleBE(0.1, 1);
    bytes[9] = 0x33;
    bytes.writeDoubleBE(0.1005, 10);
    const original = Buffer.from(bytes);
    const masked = maskUnrepresentableBinaryPlistDates(bytes, [1, 10]);
    expect(masked).not.toBe(bytes);
    expect(bytes).toEqual(original);
    expect(masked.readDoubleBE(1)).toBe(0.1);
    expect(Number.isNaN(masked.readDoubleBE(10))).toBe(true);
    expect(maskUnrepresentableBinaryPlistDates(bytes, [1])).toBe(bytes);
    expect(maskUnrepresentableBinaryPlistDates(bytes, [])).toBe(bytes);
  });
});
