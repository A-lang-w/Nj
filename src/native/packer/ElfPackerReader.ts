import type { PackerRegion } from "../../domain/native/packerIndicators.js";
import {
  ENTROPY_BUDGET_LIMITATION,
  entropyMeter,
  formatFailure,
  hexAddress,
} from "./packerFacts.js";
import { clampRange, decodeName, type ImageFacts } from "./imageFacts.js";

const PT_LOAD = 1;
const PF_X = 1;
const PF_W = 2;
const PF_R = 4;
const SHT_NOBITS = 8;
const SHF_WRITE = 1n;
const SHF_ALLOC = 2n;
const SHF_EXECINSTR = 4n;
const MAX_HEADERS = 65535;
const SHN_XINDEX = 0xffff;
const PN_XNUM = 0xffff;
const MAX_NAME = 256;

const size = (value: bigint, what: string): number => {
  if (value > BigInt(Number.MAX_SAFE_INTEGER))
    formatFailure(`ELF ${what} exceeds the supported range.`);
  return Number(value);
};

/** ELF32/ELF64 reader over program and optional section headers, either byte order. */
export const readElfPackerFacts = (bytes: Buffer): ImageFacts => {
  if (bytes.length < 52) formatFailure("Truncated ELF header.");
  const elf64 = bytes[4] === 2;
  if (bytes[4] !== 1 && !elf64) formatFailure("Unsupported ELF class.");
  const little = bytes[5] === 1;
  if (bytes[5] !== 1 && bytes[5] !== 2)
    formatFailure("Unsupported ELF byte order.");
  if (elf64 && bytes.length < 64) formatFailure("Truncated ELF64 header.");
  const u16 = (at: number) =>
    little ? bytes.readUInt16LE(at) : bytes.readUInt16BE(at);
  const u32 = (at: number) =>
    little ? bytes.readUInt32LE(at) : bytes.readUInt32BE(at);
  const word = (at: number): bigint =>
    elf64
      ? little
        ? bytes.readBigUInt64LE(at)
        : bytes.readBigUInt64BE(at)
      : BigInt(u32(at));
  const need = (offset: number, length: number) => {
    if (offset > bytes.length - length)
      formatFailure(
        `ELF range ${String(offset)} + ${String(length)} leaves the artifact.`,
      );
  };
  const type = u16(16);
  const machine = u16(18);
  const entry = word(24);
  const phoff = size(word(elf64 ? 32 : 28), "program header offset");
  const shoff = size(word(elf64 ? 40 : 32), "section header offset");
  const at = elf64 ? 52 : 40;
  const phentsize = u16(at + 2);
  const phnum = u16(at + 4);
  const shentsize = u16(at + 6);
  let shnum = u16(at + 8);
  let shstrndx = u16(at + 10);
  const headerSize = elf64 ? 64 : 52;
  const phMin = elf64 ? 56 : 32;
  const shMin = elf64 ? 64 : 40;
  if (phnum > 0 && phentsize < phMin)
    formatFailure("ELF program header entries are too small.");
  if (phnum === PN_XNUM)
    formatFailure("Extended ELF program header counts are not supported.");
  // Extended section numbering: e_shnum == 0 with a section table, or
  // e_shstrndx == SHN_XINDEX, keeps the real values in section header 0.
  if ((shnum === 0 && shoff !== 0) || shstrndx === SHN_XINDEX) {
    if (shentsize < shMin)
      formatFailure("ELF section header entries are too small.");
    need(shoff, shMin);
    if (shnum === 0) {
      const count = size(
        word(elf64 ? shoff + 32 : shoff + 20),
        "section count",
      );
      if (count === 0)
        formatFailure("ELF declares a section table with zero sections.");
      if (count > MAX_HEADERS * 4)
        formatFailure(
          "ELF extended section count exceeds the supported range.",
        );
      shnum = count;
    }
    if (shstrndx === SHN_XINDEX) shstrndx = u32(shoff + (elf64 ? 40 : 24));
  }
  if (phnum > 0) need(phoff, phnum * phentsize);
  const limitations: string[] = [];
  let incomplete = false;
  const regions: PackerRegion[] = [];
  const entropy = entropyMeter(bytes);
  const nameLocations = new Map<number, { offset: number; bytes: number }>();
  let mappedEnd = Math.max(
    headerSize,
    phnum > 0 ? phoff + phnum * phentsize : 0,
  );
  const region = (
    kind: PackerRegion["kind"],
    name: { name: string; name_hex: string } | null,
    address: bigint,
    virtualSize: number,
    offset: number,
    fileBytes: number,
    flags: number,
    access: { r: boolean; w: boolean; x: boolean },
  ) => {
    const raw = clampRange(bytes.length, offset, fileBytes);
    if (raw.truncated) {
      incomplete = true;
      limitations.push(
        `ELF ${kind} at file offset ${String(offset)} declares bytes beyond the end of the file; entropy covers only the present bytes.`,
      );
    }
    if (fileBytes > 0) mappedEnd = Math.max(mappedEnd, raw.offset + raw.bytes);
    const value: PackerRegion = {
      index: regions.length,
      kind,
      name: name?.name ?? null,
      name_hex: name?.name_hex ?? null,
      virtual_address: hexAddress(address),
      virtual_size: virtualSize,
      raw: { offset: raw.offset, bytes: raw.bytes },
      flags_value: flags,
      readable: access.r,
      writable: access.w,
      executable: access.x,
      entropy: entropy.measure(raw.offset, raw.bytes),
    };
    regions.push(value);
    return value;
  };
  let entryRegion: PackerRegion | undefined;
  let entryFileOffset: number | null = null;
  for (let index = 0; index < phnum; index++) {
    const base = phoff + index * phentsize;
    const offset = size(word(elf64 ? base + 8 : base + 4), "segment offset");
    if (u32(base) !== PT_LOAD) {
      // Non-load segments (notes, dynamic, ...) still own file bytes, so they
      // bound the overlay even though they are not reported as regions.
      const declared = size(
        word(elf64 ? base + 32 : base + 16),
        "segment size",
      );
      const range = clampRange(bytes.length, offset, declared);
      if (range.bytes > 0)
        mappedEnd = Math.max(mappedEnd, range.offset + range.bytes);
      continue;
    }
    const flags = elf64 ? u32(base + 4) : u32(base + 24);
    const vaddr = word(elf64 ? base + 16 : base + 8);
    const filesz = size(word(elf64 ? base + 32 : base + 16), "segment size");
    const memsz = size(word(elf64 ? base + 40 : base + 20), "segment size");
    const segment = region(
      "segment",
      null,
      vaddr,
      memsz,
      offset,
      filesz,
      flags,
      {
        r: (flags & PF_R) !== 0,
        w: (flags & PF_W) !== 0,
        x: (flags & PF_X) !== 0,
      },
    );
    if (
      entryRegion === undefined &&
      entry >= vaddr &&
      entry < vaddr + BigInt(memsz)
    ) {
      entryRegion = segment;
      const delta = Number(entry - vaddr);
      entryFileOffset = delta < segment.raw.bytes ? offset + delta : null;
    }
  }
  if (shnum > 0) {
    if (shentsize < shMin)
      formatFailure("ELF section header entries are too small.");
    need(shoff, shnum * shentsize);
    mappedEnd = Math.max(mappedEnd, shoff + shnum * shentsize);
    const header = (index: number) => {
      const base = shoff + index * shentsize;
      return {
        name: u32(base),
        type: u32(base + 4),
        flags: word(base + 8),
        address: word(elf64 ? base + 16 : base + 12),
        offset: size(word(elf64 ? base + 24 : base + 16), "section offset"),
        size: size(word(elf64 ? base + 32 : base + 20), "section size"),
      };
    };
    const strings =
      shstrndx !== 0 && shstrndx < shnum ? header(shstrndx) : undefined;
    if (shstrndx !== 0 && strings === undefined) {
      incomplete = true;
      limitations.push(
        `ELF section-name table index ${String(shstrndx)} is outside the section table; section names are not reported.`,
      );
    }
    let namesEscaped = false;
    // A name must be NUL-terminated inside the declared string table.
    const nameOf = (offset: number) => {
      if (strings === undefined) return null;
      const tableEnd = Math.min(bytes.length, strings.offset + strings.size);
      const start = strings.offset + offset;
      const terminator =
        offset < strings.size && start < tableEnd
          ? bytes
              .subarray(0, Math.min(tableEnd, start + MAX_NAME))
              .indexOf(0, start)
          : -1;
      if (terminator === -1) {
        namesEscaped = true;
        return null;
      }
      return { start, value: decodeName(bytes.subarray(start, terminator)) };
    };
    for (let index = 1; index < shnum; index++) {
      const section = header(index);
      const nobits = section.type === SHT_NOBITS;
      const name = nameOf(section.name);
      if (name !== null)
        nameLocations.set(regions.length, {
          offset: name.start,
          bytes: name.value.name.length,
        });
      region(
        "section",
        name?.value ?? null,
        section.address,
        section.size,
        section.offset,
        nobits ? 0 : section.size,
        Number(section.flags & 0xffffffffn),
        {
          r: (section.flags & SHF_ALLOC) !== 0n,
          w: (section.flags & SHF_WRITE) !== 0n,
          x: (section.flags & SHF_EXECINSTR) !== 0n,
        },
      );
    }
    if (namesEscaped) {
      incomplete = true;
      limitations.push(
        "Some ELF section names are not terminated inside the section-name table; those names are not reported.",
      );
    }
  }
  if (entropy.exhausted) {
    incomplete = true;
    limitations.push(ENTROPY_BUDGET_LIMITATION);
  }
  return {
    format: elf64 ? "elf64" : "elf32",
    machine,
    regions,
    entryAddress: entry,
    entryApplicable: entry !== 0n && (type === 2 || type === 3),
    entryRegion,
    entryFileOffset,
    firstSectionIndex: undefined,
    imports: { status: "not_applicable" },
    mappedEnd,
    certificateTable: null,
    nameLocations,
    elfWithoutSections: shnum === 0 && (type === 2 || type === 3),
    limitations: [
      ...limitations,
      "ELF entry placement is evaluated against PT_LOAD segments; dynamic-symbol import heuristics are not applied to ELF.",
    ],
    incomplete,
  };
};
