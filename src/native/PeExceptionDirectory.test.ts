import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PE_EXCEPTION_DIRECTORY_INDEX } from "./pe/PeImageLayout.js";
import {
  inspectPeExceptionDirectory,
  parsePeExceptionDirectory,
  PE_RUNTIME_FUNCTION_BYTES,
} from "./PeExceptionDirectory.js";

const HEADER_BYTES = 0x400;
const SECTION_ALIGNMENT = 0x200;
const AMD64 = 0x8664;
const ARM64 = 0xaa64;
const EXTENT_STRIDE = PE_RUNTIME_FUNCTION_BYTES;

interface SectionSpec {
  readonly name: string;
  readonly rva: number;
  readonly virtualSize: number;
  /** Overrides the alignment-rounded SizeOfRawData, for exact-byte bounds. */
  readonly rawSize?: number;
}

/** Build a source-owned PE32/PE32+ image. No compiled binary is committed. */
const buildPe = (options: {
  readonly plus?: boolean;
  readonly machine?: number;
  readonly sections: readonly SectionSpec[];
  readonly exception?: { readonly rva: number; readonly size: number } | null;
  readonly directoryCount?: number;
}) => {
  const plus = options.plus ?? true;
  const machine = options.machine ?? (plus ? AMD64 : 0x014c);
  const optionalSize = plus ? 240 : 224;
  const directoryCount = options.directoryCount ?? 16;
  const rawSizes = options.sections.map(
    (section) =>
      section.rawSize ??
      Math.max(
        SECTION_ALIGNMENT,
        Math.ceil(section.virtualSize / SECTION_ALIGNMENT) * SECTION_ALIGNMENT,
      ),
  );
  const fileOffsets: number[] = [];
  let cursor = HEADER_BYTES;
  for (const rawSize of rawSizes) {
    fileOffsets.push(cursor);
    cursor += rawSize;
  }
  const bytes = Buffer.alloc(cursor);
  bytes.writeUInt16LE(0x5a4d, 0);
  bytes.write("PE fixture", 0x40, "latin1");
  bytes.writeUInt32LE(0x80, 60);
  bytes.writeUInt32LE(0x4550, 0x80);
  bytes.writeUInt16LE(machine, 0x84);
  bytes.writeUInt16LE(options.sections.length, 0x86);
  bytes.writeUInt16LE(optionalSize, 0x94);
  bytes.writeUInt16LE(0x2022, 0x96);
  const optional = 0x98;
  bytes.writeUInt16LE(plus ? 0x20b : 0x10b, optional);
  bytes.writeUInt32LE(0x1000, optional + 20);
  bytes.writeUInt32LE(cursor, optional + 56);
  bytes.writeUInt32LE(HEADER_BYTES, optional + 60);
  const countAt = optional + (plus ? 108 : 92);
  bytes.writeUInt32LE(directoryCount, countAt);
  if (options.exception != null) {
    const at = countAt + 4 + PE_EXCEPTION_DIRECTORY_INDEX * 8;
    bytes.writeUInt32LE(options.exception.rva, at);
    bytes.writeUInt32LE(options.exception.size, at + 4);
  }
  const table = optional + optionalSize;
  options.sections.forEach((section, index) => {
    const at = table + index * 40;
    bytes.write(section.name.padEnd(8, "\0").slice(0, 8), at, "latin1");
    bytes.writeUInt32LE(section.virtualSize, at + 8);
    bytes.writeUInt32LE(section.rva, at + 12);
    bytes.writeUInt32LE(rawSizes[index] ?? 0, at + 16);
    bytes.writeUInt32LE(fileOffsets[index] ?? 0, at + 20);
  });
  return { bytes, fileOffsets };
};

const writeRecord = (
  bytes: Buffer,
  at: number,
  begin: number,
  end: number,
  unwind = 0,
): void => {
  bytes.writeUInt32LE(begin, at);
  bytes.writeUInt32LE(end, at + 4);
  bytes.writeUInt32LE(unwind, at + 8);
};

/** Two-section image whose `.pdata` holds `records`. */
const fixtureWithRecords = (
  records: readonly (readonly [number, number])[],
  plus = true,
) => {
  const fixture = buildPe({
    plus,
    sections: [
      { name: ".text", rva: 0x1000, virtualSize: 0x1000 },
      {
        name: ".pdata",
        rva: 0x2000,
        virtualSize: records.length * EXTENT_STRIDE,
      },
    ],
    exception: { rva: 0x2000, size: records.length * EXTENT_STRIDE },
  });
  const base = fixture.fileOffsets[1] ?? 0;
  records.forEach(([begin, end], index) =>
    writeRecord(
      fixture.bytes,
      base + index * EXTENT_STRIDE,
      begin,
      end,
      0x3000,
    ),
  );
  return fixture;
};

const extents = (records: readonly (readonly [number, number])[]) =>
  records.map(([begin, end]) => ({ begin, end }));

const limitsOf = (limitations: readonly string[]) => limitations.join("\n");

describe("measuring declared PE Exception Directory extents", () => {
  it.each([
    [false, "pe32", 96],
    [true, "pe32-plus", 112],
  ])(
    "measures exact extents from the declared directory (PE32+ = %s)",
    (plus, format, directoryOffsetWithin) => {
      const records = [
        [0x1000, 0x1020],
        [0x1020, 0x1030],
        [0x1030, 0x1080],
      ] as const;
      const { bytes } = fixtureWithRecords(records, plus === true);
      // The two formats place Data Directory 3 at different optional-header
      // offsets; both must resolve to the same declared records.
      expect(
        bytes.readUInt32LE(0x98 + (directoryOffsetWithin as number) + 3 * 8),
      ).toBe(0x2000);
      const result = parsePeExceptionDirectory(bytes);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.format).toBe(format);
      expect(result.value.declaredCount).toBe(3);
      expect(result.value.coverage).toBe(1);
      expect(result.value.complete).toBe(true);
      expect(result.value.entries).toEqual(extents(records));
      expect(result.value.rejectedCount).toBe(0);
      expect(result.value.duplicateCount).toBe(0);
      expect(result.value.unmappedCount).toBe(0);
    },
  );

  it("keeps limitations populated on a clean complete read", () => {
    const { bytes } = fixtureWithRecords([[0x1000, 0x1020]]);
    const result = parsePeExceptionDirectory(bytes);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.limitations.length).toBeGreaterThan(0);
    expect(limitsOf(result.value.limitations)).toContain(
      "measured, not symbol-derived",
    );
  });

  it("rejects duplicate and invalid records while keeping the valid ones", () => {
    const { bytes } = fixtureWithRecords([
      [0x1000, 0x1020],
      [0x1000, 0x1020],
      [0x0, 0x0],
      [0x500, 0x400],
      [0x1020, 0x1030],
    ]);
    const result = parsePeExceptionDirectory(bytes);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.entries).toEqual([
      { begin: 0x1000, end: 0x1020 },
      { begin: 0x1020, end: 0x1030 },
    ]);
    expect(result.value.declaredCount).toBe(5);
    expect(result.value.duplicateCount).toBe(1);
    expect(result.value.rejectedCount).toBe(2);
    expect(limitsOf(result.value.limitations)).toContain("Rejected 2 of 5");
    expect(limitsOf(result.value.limitations)).toContain("Collapsed 1");
  });

  it("fails rather than reporting a clean zero-extent result when every record is malformed", () => {
    const { bytes } = fixtureWithRecords([
      [0x500, 0x400],
      [0x0, 0x0],
    ]);
    const result = parsePeExceptionDirectory(bytes);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("exception-directory-malformed");
  });

  it("counts extents no section maps rather than dropping them silently", () => {
    const { bytes } = fixtureWithRecords([
      [0x1000, 0x1020],
      [0x9000, 0x9020],
    ]);
    const result = parsePeExceptionDirectory(bytes);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.entries).toHaveLength(2);
    expect(result.value.unmappedCount).toBe(1);
    expect(limitsOf(result.value.limitations)).toContain("no section maps");
  });
});

describe("refusing absent and unsupported PE images", () => {
  it("reports an absent Exception Directory as a tagged failure, never zero extents", () => {
    const { bytes } = buildPe({
      sections: [{ name: ".text", rva: 0x1000, virtualSize: 0x1000 }],
      exception: null,
    });
    const result = parsePeExceptionDirectory(bytes);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("exception-directory-absent");
    expect(result.error.reason).toContain("fact about the file");
  });

  it("rejects a directory declaring an RVA without a size", () => {
    const { bytes } = buildPe({
      sections: [{ name: ".pdata", rva: 0x2000, virtualSize: 0x1000 }],
      exception: { rva: 0x2000, size: 0 },
    });
    const result = parsePeExceptionDirectory(bytes);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("exception-directory-inconsistent");
  });

  it("rejects non-PE input cleanly instead of mis-parsing it", () => {
    const dosStubWithoutSignature = Buffer.alloc(0x400);
    dosStubWithoutSignature.writeUInt16LE(0x5a4d, 0);
    dosStubWithoutSignature.writeUInt32LE(0x80, 60);
    for (const bytes of [
      Buffer.alloc(0x400),
      Buffer.from(
        "not a pe at all, just some plain text.".padEnd(0x400, " "),
        "latin1",
      ),
      Buffer.from("\x7fELF\x02\x01\x01\x00".padEnd(0x400, "\0"), "latin1"),
      dosStubWithoutSignature,
    ]) {
      const result = parsePeExceptionDirectory(bytes);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.error.code).toBe("not-a-pe");
    }
  });

  it("rejects a header too short to hold an MZ record", () => {
    const result = parsePeExceptionDirectory(Buffer.from("MZ", "latin1"));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("truncated-header");
  });

  it("refuses a machine whose RUNTIME_FUNCTION stride is not verified", () => {
    const { bytes } = fixtureWithRecords([[0x1000, 0x1020]]);
    bytes.writeUInt16LE(ARM64, 0x84);
    const result = parsePeExceptionDirectory(bytes);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("unsupported-machine");
  });
});

describe("bounding PE Exception Directory reads to file-backed bytes", () => {
  it("bounds the read by the section table rather than the declared size or SizeOfImage", () => {
    // Declare 100 records; the section's file-backed bytes hold 42 of them.
    const declaredCount = 100;
    const readable = Math.floor(0x200 / EXTENT_STRIDE);
    const fixture = buildPe({
      sections: [
        { name: ".text", rva: 0x1000, virtualSize: 0x1000 },
        { name: ".pdata", rva: 0x2000, virtualSize: 0x100 },
      ],
      exception: { rva: 0x2000, size: declaredCount * EXTENT_STRIDE },
    });
    const base = fixture.fileOffsets[1] ?? 0;
    for (let index = 0; index < readable; index++)
      writeRecord(
        fixture.bytes,
        base + index * EXTENT_STRIDE,
        0x1000 + index * 0x10,
        0x1008 + index * 0x10,
      );
    const result = parsePeExceptionDirectory(fixture.bytes);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The file itself is long enough for all 100 declared records; only the
    // section table stops the read. SizeOfImage is larger still.
    expect(fixture.bytes.length).toBeGreaterThan(declaredCount * EXTENT_STRIDE);
    expect(readable).toBe(42);
    expect(result.value.declaredCount).toBe(declaredCount);
    expect(result.value.entries).toHaveLength(42);
    expect(result.value.coverage).toBeCloseTo(42 / declaredCount, 6);
    expect(result.value.complete).toBe(false);
    expect(limitsOf(result.value.limitations)).toContain(
      "Partial read: 42 of 100",
    );
  });

  it("reports partial coverage when the directory declares more than its section file-backs", () => {
    const records = [
      [0x1000, 0x1020],
      [0x1020, 0x1030],
      [0x1030, 0x1080],
      [0x1080, 0x1090],
    ] as const;
    const readable = 3;
    const fixture = buildPe({
      sections: [
        { name: ".text", rva: 0x1000, virtualSize: 0x1000 },
        // Exactly three records are file-backed.
        {
          name: ".pdata",
          rva: 0x2000,
          virtualSize: 0x1000,
          rawSize: readable * EXTENT_STRIDE,
        },
      ],
      exception: { rva: 0x2000, size: records.length * EXTENT_STRIDE },
    });
    const base = fixture.fileOffsets[1] ?? 0;
    records
      .slice(0, readable)
      .forEach(([begin, end], index) =>
        writeRecord(fixture.bytes, base + index * EXTENT_STRIDE, begin, end),
      );
    const result = parsePeExceptionDirectory(fixture.bytes);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.entries).toEqual(extents(records.slice(0, readable)));
    expect(result.value.declaredCount).toBe(4);
    expect(result.value.coverage).toBeCloseTo(0.75, 6);
    expect(result.value.complete).toBe(false);
    expect(limitsOf(result.value.limitations)).toContain(
      "Partial read: 3 of 4",
    );
  });

  it("fails rather than reading past an image truncated inside a section", () => {
    const { bytes, fileOffsets } = fixtureWithRecords([
      [0x1000, 0x1020],
      [0x1020, 0x1030],
    ]);
    // Cut inside `.pdata`'s raw range: the image itself is truncated, which is
    // a different fact from a directory that outruns its own section.
    const result = parsePeExceptionDirectory(bytes, (fileOffsets[1] ?? 0) + 4);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("truncated-header");
    expect(result.error.reason).toContain("outside the artifact");
  });
});

describe("resolving addresses against PE Exception Directory extents", () => {
  it("resolves an address to its containing function and iterates extents", () => {
    const { bytes } = fixtureWithRecords([
      [0x1000, 0x1020],
      [0x1020, 0x1030],
      [0x1100, 0x1180],
    ]);
    const result = parsePeExceptionDirectory(bytes);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { functionAt, extentsIn } = result.value;
    expect(functionAt(0x1000)).toEqual({ begin: 0x1000, end: 0x1020 });
    expect(functionAt(0x1010)).toEqual({ begin: 0x1000, end: 0x1020 });
    // End is exclusive, so an address at EndAddress opens the next function.
    expect(functionAt(0x1020)).toEqual({ begin: 0x1020, end: 0x1030 });
    expect(functionAt(0x0fff)).toBeUndefined();
    expect(functionAt(0x1180)).toBeUndefined();
    expect(functionAt(0x9000)).toBeUndefined();
    expect(functionAt(-1)).toBeUndefined();
    expect(functionAt(1.5)).toBeUndefined();
    // A range overlapping two extents yields both; a gap yields none.
    expect([...extentsIn(0x1018, 0x10)]).toEqual([
      { begin: 0x1000, end: 0x1020 },
      { begin: 0x1020, end: 0x1030 },
    ]);
    expect([...extentsIn(0x1050, 0x10)]).toEqual([]);
    expect([...extentsIn(0x1100, 0x10)]).toEqual([
      { begin: 0x1100, end: 0x1180 },
    ]);
    expect([...extentsIn(0x1000, 0)]).toEqual([]);
  });
});

describe("PE Exception Directory file reads", () => {
  let directory = "";

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "rea-pdata-"));
  });

  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("measures the same extents from a file as from memory", async () => {
    const records = [
      [0x1000, 0x1020],
      [0x1020, 0x1030],
      [0x1030, 0x1080],
    ] as const;
    const { bytes } = fixtureWithRecords(records);
    const path = join(directory, "sample.dll");
    await writeFile(path, bytes);
    const fromFile = await inspectPeExceptionDirectory(path);
    expect(fromFile.ok).toBe(true);
    if (!fromFile.ok) return;
    expect(fromFile.value.entries).toEqual(extents(records));
    expect(fromFile.value.declaredCount).toBe(3);
    expect(fromFile.value.coverage).toBe(1);
    const fromMemory = parsePeExceptionDirectory(bytes);
    expect(fromMemory.ok).toBe(true);
    if (!fromMemory.ok) return;
    expect(fromFile.value.entries).toEqual(fromMemory.value.entries);
  });

  it("returns a tagged failure for a file that is not a PE", async () => {
    const path = join(directory, "not-a-pe.bin");
    await writeFile(path, Buffer.alloc(0x400));
    const result = await inspectPeExceptionDirectory(path);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("not-a-pe");
  });
});
