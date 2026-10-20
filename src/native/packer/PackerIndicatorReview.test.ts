import { describe, expect, it } from "vitest";

import { packerIndicatorsSchema } from "../../domain/native/packerIndicators.js";
import { parsePackerIndicators } from "./PackerIndicatorParser.js";
import { elfImage, noise, peImage, plain } from "./PackerIndicators.fixture.js";

const parse = (bytes: Buffer) => {
  const report = parsePackerIndicators(bytes, {
    path: "/fixtures/image",
    sha256: "0".repeat(64),
    bytes: bytes.length,
  });
  expect(packerIndicatorsSchema.parse(report)).toEqual(report);
  return report;
};
const ids = (report: ReturnType<typeof parse>) =>
  report.indicators.map((item) => item.id);

// ELF64 little-endian header field offsets.
const SHOFF = 40;
const SHNUM = 60;
const SHSTRNDX = 62;
const SHENT = 64;

const sectionedElf = (names: readonly string[], data = plain(0x400)) =>
  elfImage({
    entry: 0x401000n,
    segments: [{ flags: 5, vaddr: 0x401000n, data }],
    sections: names.map((name) => ({ name, flags: 6, segment: 0 })),
  });

describe("ELF packer indicator hardening", () => {
  it("bounds entropy work when many headers overlap one payload", () => {
    const count = 4000;
    const payload = noise(0x40000);
    const phoff = 64;
    const dataAt = phoff + count * 56;
    const image = Buffer.alloc(dataAt + payload.length);
    image.writeUInt32BE(0x7f454c46, 0);
    image[4] = 2;
    image[5] = 1;
    image[6] = 1;
    image.writeUInt16LE(2, 16);
    image.writeUInt16LE(62, 18);
    image.writeBigUInt64LE(0x400000n, 24);
    image.writeBigUInt64LE(BigInt(phoff), 32);
    image.writeUInt16LE(56, 54);
    image.writeUInt16LE(count, 56);
    for (let index = 0; index < count; index++) {
      const base = phoff + index * 56;
      image.writeUInt32LE(1, base);
      image.writeUInt32LE(5, base + 4);
      image.writeBigUInt64LE(BigInt(dataAt), base + 8);
      image.writeBigUInt64LE(0x400000n, base + 16);
      // Distinct sizes defeat range caching; only the shared budget helps.
      const bytes = BigInt(payload.length - index);
      image.writeBigUInt64LE(bytes, base + 32);
      image.writeBigUInt64LE(bytes, base + 40);
    }
    payload.copy(image, dataAt);
    const started = Date.now();
    const report = parse(image);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(report.regions.some((region) => region.entropy === null)).toBe(true);
    expect(report.limitations.join("\n")).toContain("entropy work budget");
    expect(report.verdict.status).not.toBe("not_observed");
  });

  it("counts a segment and its section over the same bytes once", () => {
    const report = parse(sectionedElf([".text"], noise(0x2000)));
    expect(
      ids(report).filter((id) => id === "high_entropy_executable_region"),
    ).toHaveLength(1);
    expect(report.verdict.status).toBe("unknown");
  });

  it("decodes extended section numbering when e_shnum is zero", () => {
    const image = sectionedElf([".text"]);
    const shoff = Number(image.readBigUInt64LE(SHOFF));
    const shnum = image.readUInt16LE(SHNUM);
    image.writeUInt16LE(0, SHNUM);
    image.writeBigUInt64LE(BigInt(shnum), shoff + 32);
    const report = parse(image);
    expect(ids(report)).not.toContain("elf_without_section_headers");
    expect(report.regions.map((region) => region.name)).toContain(".text");
  });

  it("does not report a trailing non-load segment as an overlay", () => {
    const image = elfImage({
      entry: 0x401000n,
      segments: [
        { flags: 5, vaddr: 0x401000n, data: plain(0x400) },
        { flags: 4, vaddr: 0n, data: Buffer.alloc(0x40, 1) },
      ],
    });
    image.writeUInt32LE(4, 64 + 56); // second header becomes PT_NOTE
    const report = parse(image);
    expect(report.overlay).toBeNull();
    expect(ids(report)).not.toContain("overlay_present");
    expect(report.verdict.status).toBe("unknown");
  });

  it("keeps section names inside the declared string table", () => {
    const image = sectionedElf(["UPX0"]);
    const shoff = Number(image.readBigUInt64LE(SHOFF));
    const strndx = image.readUInt16LE(SHSTRNDX);
    // "\0UPX0\0..." cut right after "UPX": the "0\0" lies past the table.
    image.writeBigUInt64LE(4n, shoff + strndx * SHENT + 32);
    const report = parse(image);
    expect(report.signatures.section_names).toEqual([]);
    expect(report.verdict.status).not.toBe("likely_packed");
    expect(report.limitations.join("\n")).toContain("section-name table");
  });

  it("reports an invalid section-name table index", () => {
    const image = sectionedElf([".text"]);
    image.writeUInt16LE(50, SHSTRNDX);
    const report = parse(image);
    expect(report.limitations.join("\n")).toContain("index 50");
    expect(report.verdict.status).toBe("unknown");
  });
});

describe("PE packer indicator hardening", () => {
  it("marks imports unreadable when a descriptor leaves its section", () => {
    const report = parse(
      peImage({
        entryRva: 0x1010,
        importRva: 0x2000 + 0x200 - 8,
        sections: [
          {
            name: ".text",
            virtualSize: 0x200,
            rva: 0x1000,
            raw: plain(0x200),
            characteristics: 0x60000020,
          },
          {
            name: ".rdata",
            virtualSize: 0x200,
            rva: 0x2000,
            raw: Buffer.alloc(0x200),
            characteristics: 0x40000040,
          },
          {
            name: ".data",
            virtualSize: 0x200,
            rva: 0x8000,
            raw: Buffer.alloc(0x200),
            characteristics: 0xc0000040,
          },
        ],
      }),
    );
    expect(report.imports.status).toBe("unreadable");
  });

  it("derives executable from MEM_EXECUTE, not CNT_CODE", () => {
    const report = parse(
      peImage({
        entryRva: 0,
        sections: [
          {
            name: ".code",
            virtualSize: 0x2000,
            rva: 0x1000,
            raw: noise(0x2000),
            characteristics: 0x40000020,
          },
        ],
      }),
    );
    expect(report.regions[0]?.executable).toBe(false);
    expect(ids(report)).not.toContain("high_entropy_executable_region");
  });

  it("locates section-name matches at the name bytes", () => {
    const image = peImage({
      entryRva: 0,
      sections: [
        {
          name: "UPX0",
          virtualSize: 0x1000,
          rva: 0x1000,
          raw: Buffer.alloc(0),
          characteristics: 0xe0000080,
        },
      ],
    });
    const [match] = parse(image).signatures.section_names;
    expect(match?.location.bytes).toBe(4);
    const offset = match?.location.offset ?? 0;
    expect(image.toString("latin1", offset, offset + 4)).toBe("UPX0");
  });

  it("treats header padding up to SizeOfHeaders as mapped", () => {
    const report = parse(
      peImage({
        entryRva: 0,
        sections: [
          {
            name: ".bss",
            virtualSize: 0x1000,
            rva: 0x1000,
            raw: Buffer.alloc(0),
            characteristics: 0xc0000080,
          },
        ],
      }),
    );
    expect(report.overlay).toBeNull();
  });

  it("does not treat a cut-off certificate table as complete", () => {
    const base = peImage({
      entryRva: 0,
      sections: [
        {
          name: ".text",
          virtualSize: 0x200,
          rva: 0x1000,
          raw: plain(0x200),
          characteristics: 0x60000020,
        },
      ],
    });
    const report = parse(
      peImage({
        entryRva: 0,
        sections: [
          {
            name: ".text",
            virtualSize: 0x200,
            rva: 0x1000,
            raw: plain(0x200),
            characteristics: 0x60000020,
          },
        ],
        overlay: Buffer.alloc(0x100, 7),
        certificate: { offset: base.length, bytes: 0x10000 },
      }),
    );
    expect(ids(report)).toContain("overlay_present");
    expect(report.limitations.join("\n")).toContain("certificate table");
    expect(report.verdict.status).toBe("unknown");
  });
});
