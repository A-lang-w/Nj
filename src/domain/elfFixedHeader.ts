import type {
  BinaryArchitecture,
  RawOnlyArchitecture,
} from "./binaryTargetTypes.js";
import { err, ok, type Result } from "./result.js";

export interface ElfFixedHeader {
  readonly elfClass: 32 | 64;
  readonly byteOrder: "little" | "big";
  readonly headerSize: number;
  readonly machine: number;
  readonly osAbi: number;
  readonly architecture: Exclude<
    BinaryArchitecture,
    RawOnlyArchitecture
  > | null;
}

/**
 * Validate the common, fixed ELF header commitments.
 *
 * `bytes` may be a bounded prefix. `totalBytes` is the containing file size,
 * so the declared header extent is checked against the file without requiring
 * the whole declared extent to be present in this prefix.
 */
export const readElfFixedHeader = (
  bytes: Buffer,
  totalBytes = bytes.length,
): Result<ElfFixedHeader, string> => {
  if (bytes.length >= 4 && bytes.toString("hex", 0, 4) !== "7f454c46")
    return err("not an ELF image");
  if (bytes.length < 16) return err("ELF identification is truncated");
  const classByte = bytes[4];
  if (classByte !== 1 && classByte !== 2) return err("unsupported ELF class");
  const dataByte = bytes[5];
  if (dataByte !== 1 && dataByte !== 2)
    return err("unsupported ELF endianness");
  if (bytes[6] !== 1) return err("unsupported ELF identification version");

  const elfClass = classByte === 1 ? 32 : 64;
  const minimumSize = elfClass === 32 ? 52 : 64;
  if (
    !Number.isSafeInteger(totalBytes) ||
    totalBytes < bytes.length ||
    totalBytes < minimumSize ||
    bytes.length < minimumSize
  )
    return err(
      `truncated ELF header: an ELF${elfClass} header needs ${minimumSize} bytes; the file has ${totalBytes}`,
    );
  const littleEndian = dataByte === 1;
  const readU16 = (offset: number): number =>
    littleEndian ? bytes.readUInt16LE(offset) : bytes.readUInt16BE(offset);
  const readU32 = (offset: number): number =>
    littleEndian ? bytes.readUInt32LE(offset) : bytes.readUInt32BE(offset);
  const machine = readU16(18);
  // NVIDIA CUBIN uses ELFOSABI_CUDA and a vendor ABI version in e_version.
  if (readU32(20) !== 1 && !(machine === 190 && bytes[7] === 0x33))
    return err("unsupported ELF header version");
  const headerSize = readU16(elfClass === 32 ? 40 : 52);
  if (headerSize < minimumSize || headerSize > totalBytes)
    return err("invalid ELF header size");
  return ok({
    elfClass,
    byteOrder: littleEndian ? "little" : "big",
    headerSize,
    machine,
    osAbi: bytes[7]!,
    architecture: elfArchitecture(machine) ?? null,
  });
};

/**
 * Check that the program header table the ELF header declares lies inside the
 * file. A table that runs past the end of the file cannot be read by any
 * loader, so the image is truncated or corrupt rather than merely unusual.
 *
 * `bytes` may be a bounded prefix that holds the fixed header; the declared
 * extent is compared with `totalBytes`, the containing file size. An
 * `e_phnum` of `PN_XNUM` (0xffff) keeps the real count in the first section
 * header, which a header prefix does not show, so that case is not judged.
 */
export const checkElfProgramHeaderTable = (
  bytes: Buffer,
  header: Pick<ElfFixedHeader, "elfClass" | "byteOrder">,
  totalBytes: number,
): Result<null, string> => {
  const little = header.byteOrder === "little";
  const readU16 = (offset: number): number =>
    little ? bytes.readUInt16LE(offset) : bytes.readUInt16BE(offset);
  const wide = header.elfClass === 64;
  const offset = wide
    ? little
      ? bytes.readBigUInt64LE(32)
      : bytes.readBigUInt64BE(32)
    : BigInt(little ? bytes.readUInt32LE(28) : bytes.readUInt32BE(28));
  const entrySize = readU16(wide ? 54 : 42);
  const count = readU16(wide ? 56 : 44);
  if (count === 0 || count === 0xffff) return ok(null);
  const end = offset + BigInt(entrySize) * BigInt(count);
  if (end > BigInt(totalBytes))
    return err(
      `truncated ELF program header table: the header declares ${count} entries of ${entrySize} bytes at offset ${offset}; the file has ${totalBytes}`,
    );
  return ok(null);
};

const elfArchitecture = (
  machine: number,
): Exclude<BinaryArchitecture, RawOnlyArchitecture> | undefined => {
  switch (machine) {
    case 3:
      return "x86";
    case 62:
      return "x86_64";
    case 8: // EM_MIPS: ISA, ABI and byte order remain separate ELF facts.
      return "mips";
    case 20: // EM_PPC; byte order and processor variant remain ELF declarations.
      return "powerpc";
    case 40:
      return "arm";
    case 164: // EM_HEXAGON: Qualcomm Hexagon DSP (QDSP6).
      return "hexagon";
    case 183:
      return "arm64";
    case 243: // EM_RISCV: XLEN, byte order and e_flags remain separate ELF facts.
      return "riscv";
  }
  return undefined;
};
