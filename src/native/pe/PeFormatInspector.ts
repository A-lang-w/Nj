import {
  calculateShannonEntropy,
  isLikelyPackedOrEncrypted,
} from "../ShannonEntropy.js";
import { parsePeRichHeader, type PeRichHeader } from "./PeRichHeaderParser.js";

export interface PeSectionInfo {
  readonly name: string;
  readonly virtualSize: number;
  readonly virtualAddress: number;
  readonly rawSize: number;
  readonly rawOffset: number;
  readonly characteristics: number;
  readonly entropy: number;
  readonly isPackedOrEncrypted: boolean;
  readonly isExecutable: boolean;
  readonly isWritable: boolean;
}

export interface PeDataDirectory {
  readonly name: string;
  readonly virtualAddress: number;
  readonly size: number;
}

export interface PeAuthenticodeInfo {
  readonly fileOffset: number;
  readonly size: number;
  readonly revision?: number | undefined;
  readonly certificateType?: number | undefined;
}

export interface PeFormatReport {
  readonly machine: string;
  readonly machineCode: number;
  readonly is64Bit: boolean;
  readonly numberOfSections: number;
  readonly timestamp: Date;
  readonly entryPointRva: number;
  readonly imageBase: bigint;
  readonly subsystem: string;
  readonly subsystemCode: number;
  readonly dllCharacteristics: readonly string[];
  readonly sections: readonly PeSectionInfo[];
  readonly dataDirectories: readonly PeDataDirectory[];
  readonly richHeader?: PeRichHeader | undefined;
  readonly authenticode?: PeAuthenticodeInfo | undefined;
  readonly overallEntropy: number;
}

const MACHINE_NAMES: Readonly<Record<number, string>> = {
  0x014c: "i386 (32-bit x86)",
  0x8664: "AMD64 (64-bit x86-64)",
  0x01c0: "ARM",
  0xaa64: "ARM64",
  0x0200: "IA64 (Intel Itanium)",
};

const SUBSYSTEM_NAMES: Readonly<Record<number, string>> = {
  1: "NATIVE",
  2: "WINDOWS_GUI",
  3: "WINDOWS_CUI (Console)",
  7: "POSIX_CUI",
  9: "WINDOWS_CE_GUI",
  10: "EFI_APPLICATION",
  11: "EFI_BOOT_SERVICE_DRIVER",
  12: "EFI_RUNTIME_DRIVER",
  14: "XBOX",
};

const DATA_DIRECTORY_NAMES = [
  "EXPORT",
  "IMPORT",
  "RESOURCE",
  "EXCEPTION",
  "CERTIFICATE",
  "BASE_RELOC",
  "DEBUG",
  "ARCHITECTURE",
  "GLOBAL_PTR",
  "TLS",
  "LOAD_CONFIG",
  "BOUND_IMPORT",
  "IAT",
  "DELAY_IMPORT",
  "CLR_RUNTIME_HEADER",
  "RESERVED",
] as const;

/** Decode section flags into semantic booleans. */
const isExecutableSection = (characteristics: number): boolean =>
  (characteristics & 0x20000000) !== 0; // IMAGE_SCN_MEM_EXECUTE

const isWritableSection = (characteristics: number): boolean =>
  (characteristics & 0x80000000) !== 0; // IMAGE_SCN_MEM_WRITE

const readSectionName = (header: Buffer): string => {
  return header.subarray(0, 8).toString("utf8").replace(/\0.*$/s, "");
};

/** Deep-inspect Windows PE executable (PE32 / PE32+) structures, entropy, and telemetry. */
const decodeDllCharacteristics = (dllCharValue: number): string[] => {
  const flags: string[] = [];
  if ((dllCharValue & 0x0020) !== 0) flags.push("HIGH_ENTROPY_VA");
  if ((dllCharValue & 0x0040) !== 0) flags.push("DYNAMIC_BASE (ASLR)");
  if ((dllCharValue & 0x0100) !== 0) flags.push("NX_COMPAT (DEP)");
  if ((dllCharValue & 0x0400) !== 0) flags.push("NO_SEH");
  if ((dllCharValue & 0x4000) !== 0) flags.push("GUARD_CF");
  return flags;
};

const parseDataDirectories = (
  buffer: Buffer,
  rvaOffset: number,
): {
  directories: PeDataDirectory[];
  authenticode?: PeAuthenticodeInfo | undefined;
} => {
  const directories: PeDataDirectory[] = [];
  let certInfo: PeAuthenticodeInfo | undefined;

  for (let i = 0; i < 16 && rvaOffset + (i + 1) * 8 <= buffer.length; i += 1) {
    const va = buffer.readUInt32LE(rvaOffset + i * 8);
    const size = buffer.readUInt32LE(rvaOffset + i * 8 + 4);
    const name = DATA_DIRECTORY_NAMES[i] ?? `DIR_${i}`;
    directories.push({ name, virtualAddress: va, size });

    if (i === 4 && va > 0 && size > 0 && va + size <= buffer.length) {
      const revision = size >= 8 ? buffer.readUInt16LE(va + 4) : undefined;
      const certType = size >= 8 ? buffer.readUInt16LE(va + 6) : undefined;
      certInfo = { fileOffset: va, size, revision, certificateType: certType };
    }
  }

  return { directories, authenticode: certInfo };
};

const parseSections = (
  buffer: Buffer,
  sectionsOffset: number,
  numberOfSections: number,
): PeSectionInfo[] => {
  const sections: PeSectionInfo[] = [];

  for (let i = 0; i < numberOfSections; i += 1) {
    const secOffset = sectionsOffset + i * 40;
    if (secOffset + 40 > buffer.length) break;

    const secBuf = buffer.subarray(secOffset, secOffset + 40);
    const name = readSectionName(secBuf);
    const virtualSize = secBuf.readUInt32LE(8);
    const virtualAddress = secBuf.readUInt32LE(12);
    const rawSize = secBuf.readUInt32LE(16);
    const rawOffset = secBuf.readUInt32LE(20);
    const characteristics = secBuf.readUInt32LE(36);

    const sectionBytes =
      rawOffset < buffer.length
        ? buffer.subarray(
            rawOffset,
            Math.min(rawOffset + rawSize, buffer.length),
          )
        : new Uint8Array(0);

    const entropy = calculateShannonEntropy(sectionBytes);
    const isPacked = isLikelyPackedOrEncrypted(entropy);

    sections.push({
      name,
      virtualSize,
      virtualAddress,
      rawSize,
      rawOffset,
      characteristics,
      entropy: Number(entropy.toFixed(3)),
      isPackedOrEncrypted: isPacked,
      isExecutable: isExecutableSection(characteristics),
      isWritable: isWritableSection(characteristics),
    });
  }

  return sections;
};

/** Deep-inspect Windows PE executable (PE32 / PE32+) structures, entropy, and telemetry. */
export const inspectPeFormat = (buffer: Buffer): PeFormatReport | null => {
  if (buffer.length < 64 || buffer[0] !== 0x4d || buffer[1] !== 0x5a) {
    return null;
  }

  const peOffset = buffer.readUInt32LE(0x3c);
  if (
    peOffset + 24 > buffer.length ||
    buffer[peOffset] !== 0x50 ||
    buffer[peOffset + 1] !== 0x45 ||
    buffer[peOffset + 2] !== 0x00 ||
    buffer[peOffset + 3] !== 0x00
  ) {
    return null;
  }

  const fileHeaderOffset = peOffset + 4;
  const machineCode = buffer.readUInt16LE(fileHeaderOffset);
  const numberOfSections = buffer.readUInt16LE(fileHeaderOffset + 2);
  const timeDateStampSec = buffer.readUInt32LE(fileHeaderOffset + 4);
  const sizeOfOptionalHeader = buffer.readUInt16LE(fileHeaderOffset + 16);

  const optionalHeaderOffset = fileHeaderOffset + 20;
  if (optionalHeaderOffset + sizeOfOptionalHeader > buffer.length) return null;

  const magic = buffer.readUInt16LE(optionalHeaderOffset);
  const is64Bit = magic === 0x20b;

  const entryPointRva = buffer.readUInt32LE(optionalHeaderOffset + 16);
  const imageBase = is64Bit
    ? buffer.readBigUInt64LE(optionalHeaderOffset + 24)
    : BigInt(buffer.readUInt32LE(optionalHeaderOffset + 28));

  const subsystemCode = buffer.readUInt16LE(optionalHeaderOffset + 68);
  const dllCharValue = buffer.readUInt16LE(optionalHeaderOffset + 70);
  const dllCharacteristics = decodeDllCharacteristics(dllCharValue);

  const rvaOffset = optionalHeaderOffset + (is64Bit ? 108 : 92);
  const { directories: dataDirectories, authenticode } = parseDataDirectories(
    buffer,
    rvaOffset,
  );

  const sectionsOffset = optionalHeaderOffset + sizeOfOptionalHeader;
  const sections = parseSections(buffer, sectionsOffset, numberOfSections);

  return {
    machine:
      MACHINE_NAMES[machineCode] ?? `Machine-0x${machineCode.toString(16)}`,
    machineCode,
    is64Bit,
    numberOfSections,
    timestamp: new Date(timeDateStampSec * 1000),
    entryPointRva,
    imageBase,
    subsystem: SUBSYSTEM_NAMES[subsystemCode] ?? `Subsystem-${subsystemCode}`,
    subsystemCode,
    dllCharacteristics,
    sections,
    dataDirectories,
    richHeader: parsePeRichHeader(buffer) ?? undefined,
    authenticode,
    overallEntropy: Number(calculateShannonEntropy(buffer).toFixed(3)),
  };
};
