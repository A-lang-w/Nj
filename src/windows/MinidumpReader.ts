/**
 * Windows Minidump (.dmp / MDMP) format parser for crash forensics and register analysis.
 */

export interface MinidumpException {
  readonly threadId: number;
  readonly code: number;
  readonly codeHex: string;
  readonly codeName: string;
  readonly address: bigint;
  readonly flags: number;
}

export interface MinidumpModule {
  readonly name: string | null;
  readonly baseAddress: bigint;
  readonly size: number;
  readonly timestamp: Date;
}

export interface MinidumpSystemInfo {
  readonly architecture: string;
  readonly numberOfProcessors: number;
  readonly majorVersion: number;
  readonly minorVersion: number;
  readonly buildNumber: number;
  readonly csdVersion?: string | undefined;
}

export interface MinidumpReport {
  readonly timestamp: Date;
  readonly systemInfo?: MinidumpSystemInfo | undefined;
  readonly exception?: MinidumpException | undefined;
  readonly modules: readonly MinidumpModule[];
  readonly streamTypes: readonly number[];
  readonly limitations: readonly string[];
}

const MINIDUMP_SIGNATURE = 0x504d444d; // "MDMP" in LE

const ARCH_NAMES: Readonly<Record<number, string>> = {
  0: "x86",
  5: "ARM",
  6: "IA64",
  9: "x86-64 (AMD64)",
  12: "ARM64",
};

const EXCEPTION_NAMES: Readonly<Record<number, string>> = {
  0xc0000005: "STATUS_ACCESS_VIOLATION",
  0x80000003: "STATUS_BREAKPOINT",
  0xc00000fd: "STATUS_STACK_OVERFLOW",
  0xc000001d: "STATUS_ILLEGAL_INSTRUCTION",
  0xc0000025: "STATUS_NONCONTINUABLE_EXCEPTION",
  0xc0000094: "STATUS_INTEGER_DIVIDE_BY_ZERO",
  0xc0000096: "STATUS_PRIVILEGED_INSTRUCTION",
  0xe06d7363: "CPP_EXCEPTION",
};

export const isMinidump = (buffer: Buffer): boolean => {
  return buffer.length >= 32 && buffer.readUInt32LE(0) === MINIDUMP_SIGNATURE;
};

const MAX_MINIDUMP_STRING_BYTES = 64 * 1024; // 64 KiB per string
const MAX_TOTAL_MODULE_NAME_BYTES = 1024 * 1024; // 1 MiB total for all module names

const readMinidumpString = (buffer: Buffer, rva: number): string => {
  if (rva < 0 || rva + 4 > buffer.length) return "";
  const declaredLen = buffer.readUInt32LE(rva);
  const byteLen = Math.min(declaredLen, MAX_MINIDUMP_STRING_BYTES);
  if (rva + 4 + byteLen > buffer.length) return "";
  return buffer.toString("utf16le", rva + 4, rva + 4 + byteLen);
};

const parseSystemInfoStream = (
  buffer: Buffer,
  rva: number,
  size: number,
): MinidumpSystemInfo | undefined => {
  if (rva + size > buffer.length || size < 24) return undefined;
  const archCode = buffer.readUInt16LE(rva);
  const numberOfProcessors = buffer.readUInt8(rva + 6);
  const majorVersion = buffer.readUInt32LE(rva + 8);
  const minorVersion = buffer.readUInt32LE(rva + 12);
  const buildNumber = buffer.readUInt32LE(rva + 16);
  const csdRva = size >= 28 ? buffer.readUInt32LE(rva + 24) : 0;
  const csdVersion =
    csdRva > 0 ? readMinidumpString(buffer, csdRva) : undefined;

  return {
    architecture: ARCH_NAMES[archCode] ?? `Arch-0x${archCode.toString(16)}`,
    numberOfProcessors,
    majorVersion,
    minorVersion,
    buildNumber,
    csdVersion: csdVersion || undefined,
  };
};

const parseExceptionStream = (
  buffer: Buffer,
  rva: number,
  size: number,
): MinidumpException | undefined => {
  if (rva + size > buffer.length || size < 32) return undefined;
  const threadId = buffer.readUInt32LE(rva);
  const recOffset = rva + 8; // skip threadId + alignment
  const code = buffer.readUInt32LE(recOffset);
  const flags = buffer.readUInt32LE(recOffset + 4);
  const address = buffer.readBigUInt64LE(recOffset + 16);

  const codeHex = `0x${(code >>> 0).toString(16).toUpperCase().padStart(8, "0")}`;
  const codeName = EXCEPTION_NAMES[code] ?? codeHex;

  return {
    threadId,
    code,
    codeHex,
    codeName,
    address,
    flags,
  };
};

const parseModuleListStream = (
  buffer: Buffer,
  rva: number,
  size: number,
): { readonly modules: MinidumpModule[]; readonly limitations: string[] } => {
  if (rva + size > buffer.length || size < 4) {
    return {
      modules: [],
      limitations: [
        "ModuleListStream is truncated or extends past the end of the minidump.",
      ],
    };
  }
  const count = buffer.readUInt32LE(rva);
  const modules: MinidumpModule[] = [];
  const limitations: string[] = [];
  const entrySize = 108; // MINIDUMP_MODULE size
  const maxPossibleEntries = Math.floor((size - 4) / entrySize);
  const safeCount = Math.min(count, maxPossibleEntries, 10_000);
  if (count > safeCount) {
    limitations.push(
      `ModuleListStream declared ${count} modules; only ${safeCount} entries were inspected.`,
    );
  }
  const nameCache = new Map<number, string>();
  let totalNameBytes = 0;
  let omittedNames = 0;

  for (let i = 0; i < safeCount; i += 1) {
    const offset = rva + 4 + i * entrySize;
    if (offset + entrySize > rva + size || offset + entrySize > buffer.length)
      break;

    const baseAddress = buffer.readBigUInt64LE(offset);
    const modSize = buffer.readUInt32LE(offset + 8);
    const timeDateStamp = buffer.readUInt32LE(offset + 16);
    const nameRva = buffer.readUInt32LE(offset + 20);

    let name: string | null | undefined = nameCache.get(nameRva);
    if (name === undefined) {
      if (totalNameBytes < MAX_TOTAL_MODULE_NAME_BYTES) {
        const parsedName = readMinidumpString(buffer, nameRva);
        totalNameBytes += parsedName.length * 2;
        nameCache.set(nameRva, parsedName);
        name = parsedName;
      } else {
        name = null;
        omittedNames += 1;
      }
    }

    modules.push({
      name,
      baseAddress,
      size: modSize,
      timestamp: new Date(timeDateStamp * 1000),
    });
  }

  if (omittedNames > 0) {
    limitations.push(
      `Module name budget (${MAX_TOTAL_MODULE_NAME_BYTES} bytes) exceeded; ${omittedNames} module name(s) were omitted.`,
    );
  }

  return { modules, limitations };
};

/** Parse Windows Minidump file for crash diagnosis and loaded module analysis. */
export const parseMinidump = (buffer: Buffer): MinidumpReport | null => {
  if (!isMinidump(buffer)) return null;

  const numberOfStreams = buffer.readUInt32LE(8);
  const streamDirectoryRva = buffer.readUInt32LE(12);
  const timeDateStampSec = buffer.readUInt32LE(20);

  if (streamDirectoryRva + numberOfStreams * 12 > buffer.length) {
    return null;
  }

  const streamTypes: number[] = [];
  let systemInfo: MinidumpSystemInfo | undefined;
  let exception: MinidumpException | undefined;
  let modules: MinidumpModule[] = [];
  const limitations: string[] = [];
  let hasParsedModules = false;

  for (let i = 0; i < numberOfStreams; i += 1) {
    const entryOffset = streamDirectoryRva + i * 12;
    const streamType = buffer.readUInt32LE(entryOffset);
    const dataSize = buffer.readUInt32LE(entryOffset + 4);
    const rva = buffer.readUInt32LE(entryOffset + 8);

    streamTypes.push(streamType);

    if (streamType === 7 && systemInfo === undefined) {
      // SystemInfoStream
      systemInfo = parseSystemInfoStream(buffer, rva, dataSize);
    } else if (streamType === 6 && exception === undefined) {
      // ExceptionStream
      exception = parseExceptionStream(buffer, rva, dataSize);
    } else if (streamType === 4 && !hasParsedModules) {
      // ModuleListStream
      hasParsedModules = true;
      const parsedModules = parseModuleListStream(buffer, rva, dataSize);
      modules = parsedModules.modules;
      limitations.push(...parsedModules.limitations);
    }
  }

  return {
    timestamp: new Date(timeDateStampSec * 1000),
    systemInfo,
    exception,
    modules,
    streamTypes,
    limitations,
  };
};
