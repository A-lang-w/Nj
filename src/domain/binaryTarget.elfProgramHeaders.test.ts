import { describe, expect, it } from "vitest";

import { parseExecutableHeader } from "./binaryTarget.js";
import { elf } from "./binaryTarget.fixture.js";

const reason = (bytes: Buffer, fileSize = bytes.length) => {
  const result = parseExecutableHeader(bytes, "arm64", fileSize);
  return result.ok ? null : result.error;
};

describe("ELF program header table", () => {
  const withTable = (
    bytes: Buffer,
    [offset, entrySize, count]: readonly [bigint, number, number],
  ): Buffer => {
    const little = bytes[5] === 1;
    const wide = bytes[4] === 2;
    const write16 = (value: number, at: number) =>
      little ? bytes.writeUInt16LE(value, at) : bytes.writeUInt16BE(value, at);
    if (wide) {
      if (little) bytes.writeBigUInt64LE(offset, 32);
      else bytes.writeBigUInt64BE(offset, 32);
    } else if (little) bytes.writeUInt32LE(Number(offset), 28);
    else bytes.writeUInt32BE(Number(offset), 28);
    write16(entrySize, wide ? 54 : 42);
    write16(count, wide ? 56 : 44);
    return bytes;
  };

  it.each([
    ["ELF64 little-endian", () => withTable(elf(2, 1, 62), [64n, 56, 13]), 792],
    ["ELF64 big-endian", () => withTable(elf(2, 2, 183), [64n, 56, 13]), 792],
    ["ELF32 little-endian", () => withTable(elf(1, 1, 62), [52n, 32, 2]), 116],
    ["ELF32 big-endian", () => withTable(elf(1, 2, 183), [52n, 32, 2]), 116],
  ])(
    "rejects a table that runs past the end of the file: %s",
    (_name, make, end) => {
      const bytes = make();
      expect(reason(bytes, end - 1)).toContain(
        "truncated ELF program header table",
      );
      // The table may end exactly at the end of the file.
      expect(reason(bytes, end)).toBeNull();
    },
  );

  it("names the declared entries, entry size, offset and file size", () => {
    expect(reason(withTable(elf(2, 1, 62), [64n, 56, 13]), 64)).toBe(
      "truncated ELF program header table: the header declares 13 entries of 56 bytes at offset 64; the file has 64",
    );
  });

  it("compares a 64-bit offset without overflow", () => {
    expect(
      reason(withTable(elf(2, 1, 62), [0xffffffffffffff00n, 56, 1]), 4096),
    ).toContain("at offset 18446744073709551360;");
  });

  it("does not judge an absent table or an extended program header count", () => {
    expect(reason(withTable(elf(2, 1, 62), [64n, 56, 0]), 64)).toBeNull();
    // PN_XNUM keeps the real count in a section header a prefix cannot show.
    expect(reason(withTable(elf(2, 1, 62), [64n, 56, 0xffff]), 64)).toBeNull();
  });

  it("still reports an unsupported architecture before the table", () => {
    expect(reason(withTable(elf(2, 1, 0x1234), [64n, 56, 13]), 64)).toBe(
      "unsupported ELF architecture",
    );
  });
});
