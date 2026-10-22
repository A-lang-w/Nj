import zlib from "node:zlib";
import {
  buildPythonBytecodeHeader,
  isPythonBytecode,
  resolvePythonVersion,
} from "./PythonBytecode.js";

/** PyInstaller standard cookie signature: b'MEI\x0c\x0b\x0a\x0b\x0e' */
export const PYINSTALLER_MAGIC = Buffer.from([
  0x4d, 0x45, 0x49, 0x0c, 0x0b, 0x0a, 0x0b, 0x0e,
]);

/** PyInstaller legacy cookie signature: b'MEI\x12\x13\x14\x13\x16' */
export const PYINSTALLER_OLD_MAGIC = Buffer.from([
  0x4d, 0x45, 0x49, 0x12, 0x13, 0x14, 0x13, 0x16,
]);

/** Embedded PYZ archive magic: b'PYZ\0' */
export const PYZ_MAGIC = Buffer.from([0x50, 0x59, 0x5a, 0x00]);

export interface PyInstallerCookie {
  readonly offset: number;
  readonly magic: Buffer;
  readonly pkgLength: number;
  readonly tocOffset: number;
  readonly tocLength: number;
  readonly pythonVersion: number;
  readonly pythonLibName: string;
}

export interface PyInstallerTocEntry {
  readonly name: string;
  readonly typeFlag: string;
  readonly compressionFlag: number;
  readonly pkgOffset: number;
  readonly compressedLength: number;
  readonly uncompressedLength: number;
}

export interface PyzModuleEntry {
  readonly name: string;
  readonly typeCode: number;
  readonly isPackage: boolean;
  readonly dataOffset: number;
  readonly dataLength: number;
}

export interface PyzArchive {
  readonly magic: Buffer;
  readonly pycMagic: number;
  readonly pythonVersion: string;
  readonly tocOffset: number;
  readonly modules: readonly PyzModuleEntry[];
}

export interface PyInstallerArchive {
  readonly cookie: PyInstallerCookie;
  readonly carchiveOffset: number;
  readonly tocEntries: readonly PyInstallerTocEntry[];
  readonly embeddedPyz?: PyzArchive | undefined;
}

export interface ExtractedPyInstallerFile {
  readonly name: string;
  readonly kind: "script" | "module" | "package" | "pyz" | "binary" | "data";
  readonly data: Buffer;
  readonly decompressed: boolean;
  readonly pythonVersion?: string | undefined;
  readonly limitations: readonly string[];
}

/** Check if binary buffer contains PyInstaller cookie. */
export const isPyInstallerBinary = (buffer: Buffer): boolean => {
  return findPyInstallerCookie(buffer) !== null;
};

/** Scan binary buffer backwards to locate the PyInstaller CArchive cookie. */
export const findPyInstallerCookie = (
  buffer: Buffer,
): PyInstallerCookie | null => {
  if (buffer.length < 24) return null;

  let offset = buffer.lastIndexOf(PYINSTALLER_MAGIC);
  let magic = PYINSTALLER_MAGIC;
  if (offset === -1) {
    offset = buffer.lastIndexOf(PYINSTALLER_OLD_MAGIC);
    magic = PYINSTALLER_OLD_MAGIC;
  }
  if (offset === -1 || buffer.length - offset < 24) {
    return null;
  }

  const pkgLength = buffer.readUInt32BE(offset + 8);
  const tocOffset = buffer.readUInt32BE(offset + 12);
  const tocLength = buffer.readUInt32BE(offset + 16);
  const pythonVersion = buffer.readInt32BE(offset + 20);

  let pythonLibName = "";
  if (buffer.length >= offset + 88) {
    pythonLibName = buffer
      .subarray(offset + 24, offset + 88)
      .toString("ascii")
      .replace(/\0.*$/s, "");
  }

  return {
    offset,
    magic,
    pkgLength,
    tocOffset,
    tocLength,
    pythonVersion,
    pythonLibName,
  };
};

/** Parse Table of Contents and structure from a PyInstaller executable buffer. */
export const parsePyInstallerArchive = (
  buffer: Buffer,
): PyInstallerArchive | null => {
  const cookie = findPyInstallerCookie(buffer);
  if (!cookie) return null;

  const cookieBytes = buffer.length >= cookie.offset + 88 ? 88 : 24;
  const carchiveOffset = cookie.offset + cookieBytes - cookie.pkgLength;
  if (carchiveOffset < 0 || carchiveOffset + cookie.pkgLength > buffer.length) {
    return null;
  }

  const absoluteTocOffset = carchiveOffset + cookie.tocOffset;
  if (
    absoluteTocOffset < 0 ||
    absoluteTocOffset + cookie.tocLength > buffer.length
  ) {
    return null;
  }

  const tocEntries: PyInstallerTocEntry[] = [];
  let currentOffset = absoluteTocOffset;
  const endOffset = absoluteTocOffset + cookie.tocLength;

  while (
    currentOffset + 18 <= endOffset &&
    currentOffset + 18 <= buffer.length
  ) {
    const entryStructLen = buffer.readUInt32BE(currentOffset);
    if (entryStructLen < 18 || currentOffset + entryStructLen > buffer.length) {
      break;
    }

    const pkgOffset = buffer.readUInt32BE(currentOffset + 4);
    const compressedLength = buffer.readUInt32BE(currentOffset + 8);
    const uncompressedLength = buffer.readUInt32BE(currentOffset + 12);
    const compressionFlag = buffer.readUInt8(currentOffset + 16);
    const typeFlag = String.fromCharCode(buffer.readUInt8(currentOffset + 17));

    const nameRaw = buffer.subarray(
      currentOffset + 18,
      currentOffset + entryStructLen,
    );
    const name = nameRaw.toString("utf8").replace(/\0.*$/s, "");

    tocEntries.push({
      name,
      typeFlag,
      compressionFlag,
      pkgOffset,
      compressedLength,
      uncompressedLength,
    });

    currentOffset += entryStructLen;
  }

  // Find embedded PYZ if present
  let embeddedPyz: PyzArchive | undefined;
  const pyzEntry = tocEntries.find(
    (e) => e.typeFlag === "z" || e.name.toLowerCase().endsWith(".pyz"),
  );
  if (pyzEntry) {
    const pyzDataOffset = carchiveOffset + pyzEntry.pkgOffset;
    if (pyzDataOffset + pyzEntry.compressedLength <= buffer.length) {
      const rawPyz = buffer.subarray(
        pyzDataOffset,
        pyzDataOffset + pyzEntry.compressedLength,
      );
      let decompressedPyz = rawPyz;
      if (pyzEntry.compressionFlag === 1) {
        try {
          decompressedPyz = zlib.inflateSync(rawPyz);
        } catch {
          // ignore decompression failure on probe
        }
      }
      embeddedPyz = parsePyzArchive(decompressedPyz) ?? undefined;
    }
  }

  return {
    cookie,
    carchiveOffset,
    tocEntries,
    embeddedPyz,
  };
};

/**
 * Lightweight, safe Python marshal deserializer for PYZ TOC dictionaries.
 */
class SimpleMarshalReader {
  private offset: number;
  private readonly buffer: Buffer;

  constructor(buffer: Buffer, startOffset = 0) {
    this.buffer = buffer;
    this.offset = startOffset;
  }

  hasMore(): boolean {
    return this.offset < this.buffer.length;
  }

  readByte(): number {
    if (this.offset >= this.buffer.length) throw new Error("Marshal EOF");
    return this.buffer[this.offset++]!;
  }

  readUInt32LE(): number {
    if (this.offset + 4 > this.buffer.length) throw new Error("Marshal EOF");
    const val = this.buffer.readUInt32LE(this.offset);
    this.offset += 4;
    return val;
  }

  readInt32LE(): number {
    if (this.offset + 4 > this.buffer.length) throw new Error("Marshal EOF");
    const val = this.buffer.readInt32LE(this.offset);
    this.offset += 4;
    return val;
  }

  readString(len: number): string {
    if (this.offset + len > this.buffer.length) throw new Error("Marshal EOF");
    const str = this.buffer
      .subarray(this.offset, this.offset + len)
      .toString("utf8");
    this.offset += len;
    return str;
  }

  private readDict(): Record<string, unknown> {
    const dict: Record<string, unknown> = {};
    while (this.hasMore()) {
      const peek = this.buffer[this.offset];
      if (peek === 0x30) {
        this.offset += 1;
        break;
      }
      const key = this.readObject();
      if (typeof key !== "string") break;
      dict[key] = this.readObject();
    }
    return dict;
  }

  private readTuple(count: number): unknown[] {
    if (count < 0 || count > 100_000) {
      throw new Error(`Marshal tuple count ${count} exceeds limit`);
    }
    const tuple: unknown[] = [];
    for (let i = 0; i < count; i += 1) {
      tuple.push(this.readObject());
    }
    return tuple;
  }

  readObject(): unknown {
    if (!this.hasMore()) throw new Error("Marshal EOF");
    const rawType = this.readByte();
    const type = rawType & 0x7f;

    if (type === 0x7b) return this.readDict();
    if (type === 0x5b) {
      const count = this.readUInt32LE();
      if (count < 0 || count > 100_000) {
        throw new Error(`Marshal list count ${count} exceeds limit`);
      }
      const list: unknown[] = [];
      for (let i = 0; i < count; i += 1) {
        list.push(this.readObject());
      }
      return list;
    }
    if (type === 0x73 || type === 0x75 || type === 0x61 || type === 0x74) {
      return this.readString(this.readUInt32LE());
    }
    if (type === 0x7a || type === 0xda) {
      return this.readString(this.readByte());
    }
    if (type === 0x28) return this.readTuple(this.readUInt32LE());
    if (type === 0x29) return this.readTuple(this.readByte());
    if (type === 0x69) return this.readInt32LE();
    if (type === 0x49) {
      if (this.offset + 8 > this.buffer.length) throw new Error("Marshal EOF");
      const low = this.buffer.readUInt32LE(this.offset);
      this.offset += 8;
      return low;
    }
    if (type === 0x54) return true;
    if (type === 0x46) return false;
    if (type === 0x4e) return null;
    return null;
  }
}

/** Parse embedded PYZ archive header and its marshaled module table. */
export const parsePyzArchive = (pyzBuffer: Buffer): PyzArchive | null => {
  if (pyzBuffer.length < 12) return null;
  const magic = pyzBuffer.subarray(0, 4);
  if (!magic.equals(PYZ_MAGIC)) return null;

  const pycMagic = pyzBuffer.readUInt16LE(4);
  const pythonVersion = resolvePythonVersion(pycMagic);
  const tocOffset = pyzBuffer.readUInt32BE(8);

  if (tocOffset >= pyzBuffer.length) return null;

  const modules: PyzModuleEntry[] = [];
  try {
    const reader = new SimpleMarshalReader(pyzBuffer, tocOffset);
    const toc = reader.readObject();
    if (Array.isArray(toc)) {
      for (const item of toc) {
        if (!Array.isArray(item) || item.length < 2) continue;
        const name = String(item[0]);
        const val = item[1];
        if (!Array.isArray(val) || val.length < 3) continue;
        const typeCode = Number(val[0]);
        const isPackage = typeCode === 1;
        const dataOffset = Number(val[1]);
        const dataLength = Number(val[2]);
        if (Number.isFinite(dataOffset) && Number.isFinite(dataLength)) {
          modules.push({ name, typeCode, isPackage, dataOffset, dataLength });
        }
      }
    } else if (toc && typeof toc === "object") {
      for (const [name, val] of Object.entries(toc)) {
        if (!Array.isArray(val) || val.length < 3) continue;
        const typeCode = Number(val[0]);
        const isPackage = typeCode === 1;
        const dataOffset = Number(val[1]);
        const dataLength = Number(val[2]);
        if (Number.isFinite(dataOffset) && Number.isFinite(dataLength)) {
          modules.push({ name, typeCode, isPackage, dataOffset, dataLength });
        }
      }
    }
  } catch {
    // Graceful recovery on truncated or unexpected marshal forms
  }

  return {
    magic,
    pycMagic,
    pythonVersion,
    tocOffset,
    modules,
  };
};

/**
 * Extract all files, scripts, embedded modules, and libraries from a PyInstaller binary.
 * Reconstructs valid .pyc bytecode with compliant headers for decompiler compatibility.
 */
const MAX_INFLATE_BYTES = 128 * 1024 * 1024; // 128 MiB per entry limit
const inflatePayload = (
  raw: Buffer,
  flag: number,
  maxOutputBytes = MAX_INFLATE_BYTES,
): {
  readonly data: Buffer;
  readonly decompressed: boolean;
  readonly error?: string | undefined;
} => {
  if (flag === 0) return { data: raw, decompressed: true };
  try {
    return {
      data: zlib.inflateSync(raw, { maxOutputLength: maxOutputBytes }),
      decompressed: true,
    };
  } catch (err) {
    return {
      data: raw,
      decompressed: false,
      error: `Decompression error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
};

const extractPyzModule = (
  pyzData: Buffer,
  pycMagic: number,
  pythonVersion: string,
  mod: PyzModuleEntry,
): ExtractedPyInstallerFile | null => {
  // Type 3: namespace package (no payload)
  if (mod.typeCode === 3) {
    return {
      name: mod.name.replace(/\./g, "/"),
      kind: "package",
      data: Buffer.alloc(0),
      decompressed: true,
      pythonVersion,
      limitations: [],
    };
  }

  if (mod.dataOffset < 0 || mod.dataOffset + mod.dataLength > pyzData.length) {
    return null;
  }
  const raw = pyzData.subarray(mod.dataOffset, mod.dataOffset + mod.dataLength);
  const inflated = inflatePayload(raw, 1);

  // Type 2: raw data file (no bytecode header, no .pyc extension)
  if (mod.typeCode === 2) {
    if (!inflated.decompressed) {
      return {
        name: mod.name,
        kind: "data",
        data: raw,
        decompressed: false,
        pythonVersion,
        limitations: [
          inflated.error ?? "Failed to decompress PYZ data payload",
        ],
      };
    }
    return {
      name: mod.name,
      kind: "data",
      data: inflated.data,
      decompressed: true,
      pythonVersion,
      limitations: [],
    };
  }

  const modPath = mod.isPackage
    ? `${mod.name.replace(/\./g, "/")}/__init__.pyc`
    : `${mod.name.replace(/\./g, "/")}.pyc`;

  if (!inflated.decompressed) {
    return {
      name: modPath,
      kind: mod.isPackage ? "package" : "module",
      data: raw,
      decompressed: false,
      pythonVersion,
      limitations: [
        inflated.error ?? "Failed to decompress PYZ module payload",
      ],
    };
  }

  const header = buildPythonBytecodeHeader(pycMagic);
  const pycData = Buffer.concat([header, inflated.data]);
  return {
    name: modPath,
    kind: mod.isPackage ? "package" : "module",
    data: pycData,
    decompressed: true,
    pythonVersion,
    limitations: [],
  };
};

interface ScriptEntryOptions {
  readonly entry: PyInstallerTocEntry;
  readonly data: Buffer;
  readonly decompressed: boolean;
  readonly archive: PyInstallerArchive;
  readonly limitations: readonly string[];
}

const extractScriptEntry = (
  options: ScriptEntryOptions,
): ExtractedPyInstallerFile => {
  const { entry, data, decompressed, archive, limitations } = options;
  let fileData = data;
  if (decompressed && !isPythonBytecode(fileData)) {
    const pyVer: number | string =
      archive.embeddedPyz?.pycMagic ??
      archive.embeddedPyz?.pythonVersion ??
      (archive.cookie.pythonVersion > 0
        ? archive.cookie.pythonVersion < 100
          ? `${Math.floor(archive.cookie.pythonVersion / 10)}.${archive.cookie.pythonVersion % 10}`
          : `${Math.floor(archive.cookie.pythonVersion / 100)}.${archive.cookie.pythonVersion % 100}`
        : "3.10");
    const header = buildPythonBytecodeHeader(pyVer);
    fileData = Buffer.concat([header, data]);
  }

  const outName =
    entry.name.endsWith(".pyc") || entry.name.endsWith(".py")
      ? entry.name
      : `${entry.name}.pyc`;

  return {
    name: outName,
    kind:
      entry.typeFlag === "M"
        ? "package"
        : entry.typeFlag === "m"
          ? "module"
          : "script",
    data: fileData,
    decompressed,
    pythonVersion: archive.embeddedPyz?.pythonVersion,
    limitations,
  };
};

/**
 * Extract all files, scripts, embedded modules, and libraries from a PyInstaller binary.
 * Reconstructs valid .pyc bytecode with compliant headers for decompiler compatibility.
 */
export const extractPyInstallerEntries = (
  buffer: Buffer,
): ExtractedPyInstallerFile[] => {
  const archive = parsePyInstallerArchive(buffer);
  if (!archive) return [];

  const results: ExtractedPyInstallerFile[] = [];

  for (const entry of archive.tocEntries) {
    const dataOffset = archive.carchiveOffset + entry.pkgOffset;
    if (dataOffset < 0 || dataOffset + entry.compressedLength > buffer.length) {
      continue;
    }

    const rawData = buffer.subarray(
      dataOffset,
      dataOffset + entry.compressedLength,
    );
    const inflated = inflatePayload(rawData, entry.compressionFlag);
    const limitations = inflated.error ? [inflated.error] : [];

    if (entry.typeFlag === "z" || entry.name.toLowerCase().endsWith(".pyz")) {
      results.push({
        name: entry.name,
        kind: "pyz",
        data: inflated.data,
        decompressed: inflated.decompressed,
        pythonVersion: archive.embeddedPyz?.pythonVersion,
        limitations,
      });

      const pyz = parsePyzArchive(inflated.data);
      const modules = pyz?.modules ?? [];
      for (const mod of modules) {
        const extractedMod = extractPyzModule(
          inflated.data,
          pyz!.pycMagic,
          pyz!.pythonVersion,
          mod,
        );
        if (extractedMod) results.push(extractedMod);
      }
      continue;
    }

    if (["s", "m", "M"].includes(entry.typeFlag)) {
      results.push(
        extractScriptEntry({
          entry,
          data: inflated.data,
          decompressed: inflated.decompressed,
          archive,
          limitations,
        }),
      );
      continue;
    }

    results.push({
      name: entry.name,
      kind:
        entry.typeFlag === "b" || entry.typeFlag === "d" ? "binary" : "data",
      data: inflated.data,
      decompressed: inflated.decompressed,
      limitations,
    });
  }

  return results;
};
