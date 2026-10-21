import zlib from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  extractPyInstallerEntries,
  findPyInstallerCookie,
  isPyInstallerBinary,
  parsePyInstallerArchive,
  parsePyzArchive,
  PYINSTALLER_MAGIC,
  PYZ_MAGIC,
} from "./PyInstallerExtractor.js";
import { isPythonBytecode } from "./PythonBytecode.js";

const createMockPyzArchive = (): Buffer => {
  const pycMagic = Buffer.from([0x6f, 0x0d, 0x0d, 0x0a]); // 3439 (Python 3.10)
  const codeObject = Buffer.from("PRINT_HELLO_WORLD_CODE_OBJECT_12345");
  const compressedMod = zlib.deflateSync(codeObject);

  const modOffset = 12;
  const modLen = compressedMod.length;

  // Build marshaled TOC dict: { "app.engine": (False, modOffset, modLen) }
  const modName = "app.engine";
  const nameBuf = Buffer.from(modName, "utf8");

  const tocBuf = Buffer.concat([
    Buffer.from([0x7b]), // '{' dict
    Buffer.from([0x7a, nameBuf.length]), // 'z' short ascii
    nameBuf,
    Buffer.from([0x29, 3]), // ')' small tuple of 3 elements
    Buffer.from([0x46]), // 'F' False (isPackage = false)
    Buffer.from([0x69]), // 'i' int32 LE (modOffset)
    (() => {
      const b = Buffer.alloc(4);
      b.writeInt32LE(modOffset);
      return b;
    })(),
    Buffer.from([0x69]), // 'i' int32 LE (modLen)
    (() => {
      const b = Buffer.alloc(4);
      b.writeInt32LE(modLen);
      return b;
    })(),
    Buffer.from([0x30]), // '0' NULL terminator
  ]);

  const tocOffset = 12 + compressedMod.length;

  const header = Buffer.alloc(12);
  PYZ_MAGIC.copy(header, 0);
  pycMagic.copy(header, 4);
  header.writeUInt32BE(tocOffset, 8);

  return Buffer.concat([header, compressedMod, tocBuf]);
};

const createMockPyInstallerBinary = (): Buffer => {
  const bootloaderPrefix = Buffer.alloc(256, 0x90); // 256 bytes dummy executable
  const pyzData = createMockPyzArchive();

  const scriptCode = Buffer.from("MAIN_ENTRY_POINT_CODE_OBJECT_DATA");
  const compressedScript = zlib.deflateSync(scriptCode);

  const dllData = Buffer.from("MOCK_PYTHON_RUNTIME_DLL_PAYLOAD");

  // Pack data inside CArchive
  let carchiveData = Buffer.alloc(0);

  // 1. PYZ entry
  const pyzOffset = carchiveData.length;
  carchiveData = Buffer.concat([carchiveData, pyzData]);

  // 2. Script entry (compressed)
  const scriptOffset = carchiveData.length;
  carchiveData = Buffer.concat([carchiveData, compressedScript]);

  // 3. DLL entry (uncompressed)
  const dllOffset = carchiveData.length;
  carchiveData = Buffer.concat([carchiveData, dllData]);

  // Build CArchive TOC
  const createTocEntry = (options: {
    readonly name: string;
    readonly typeFlag: string;
    readonly pkgOffset: number;
    readonly compressedLen: number;
    readonly uncompressedLen: number;
    readonly compressionFlag: number;
  }): Buffer => {
    const {
      name,
      typeFlag,
      pkgOffset,
      compressedLen,
      uncompressedLen,
      compressionFlag,
    } = options;
    const nameBytes = Buffer.from(`${name}\0`, "utf8");
    const structLen = 18 + nameBytes.length;
    const entry = Buffer.alloc(structLen);
    entry.writeUInt32BE(structLen, 0);
    entry.writeUInt32BE(pkgOffset, 4);
    entry.writeUInt32BE(compressedLen, 8);
    entry.writeUInt32BE(uncompressedLen, 12);
    entry.writeUInt8(compressionFlag, 16);
    entry.writeUInt8(typeFlag.charCodeAt(0), 17);
    nameBytes.copy(entry, 18);
    return entry;
  };

  const tocEntries = Buffer.concat([
    createTocEntry({
      name: "PYZ-00.pyz",
      typeFlag: "z",
      pkgOffset: pyzOffset,
      compressedLen: pyzData.length,
      uncompressedLen: pyzData.length,
      compressionFlag: 0,
    }),
    createTocEntry({
      name: "main.py",
      typeFlag: "s",
      pkgOffset: scriptOffset,
      compressedLen: compressedScript.length,
      uncompressedLen: scriptCode.length,
      compressionFlag: 1,
    }),
    createTocEntry({
      name: "python310.dll",
      typeFlag: "b",
      pkgOffset: dllOffset,
      compressedLen: dllData.length,
      uncompressedLen: dllData.length,
      compressionFlag: 0,
    }),
  ]);

  const tocOffset = carchiveData.length;
  const tocLength = tocEntries.length;
  const pkgLength = carchiveData.length + tocLength;

  // Build PyInstaller Cookie (88 bytes)
  const cookie = Buffer.alloc(88);
  PYINSTALLER_MAGIC.copy(cookie, 0);
  cookie.writeUInt32BE(pkgLength, 8);
  cookie.writeUInt32BE(tocOffset, 12);
  cookie.writeUInt32BE(tocLength, 16);
  cookie.writeInt32BE(310, 20); // Python 3.10
  Buffer.from("python310.dll\0", "ascii").copy(cookie, 24);

  return Buffer.concat([bootloaderPrefix, carchiveData, tocEntries, cookie]);
};

describe("PyInstallerExtractor", () => {
  it("detects PyInstaller cookie and extracts metadata", () => {
    const mockBinary = createMockPyInstallerBinary();
    expect(isPyInstallerBinary(mockBinary)).toBe(true);

    const cookie = findPyInstallerCookie(mockBinary);
    expect(cookie).not.toBeNull();
    expect(cookie?.pythonVersion).toBe(310);
    expect(cookie?.pythonLibName).toBe("python310.dll");
  });

  it("parses PYZ archive header and embedded modules", () => {
    const mockPyz = createMockPyzArchive();
    const pyz = parsePyzArchive(mockPyz);
    expect(pyz).not.toBeNull();
    expect(pyz?.pythonVersion).toBe("3.10");
    expect(pyz?.modules.length).toBe(1);
    expect(pyz?.modules[0]?.name).toBe("app.engine");
    expect(pyz?.modules[0]?.isPackage).toBe(false);
  });

  it("parses PyInstaller CArchive TOC structure", () => {
    const mockBinary = createMockPyInstallerBinary();
    const archive = parsePyInstallerArchive(mockBinary);
    expect(archive).not.toBeNull();
    expect(archive?.tocEntries.length).toBe(3);

    const names = archive?.tocEntries.map((e) => e.name);
    expect(names).toContain("PYZ-00.pyz");
    expect(names).toContain("main.py");
    expect(names).toContain("python310.dll");
    expect(archive?.embeddedPyz).toBeDefined();
    expect(archive?.embeddedPyz?.pythonVersion).toBe("3.10");
  });

  it("extracts all entries and reconstructs valid .pyc bytecode files", () => {
    const mockBinary = createMockPyInstallerBinary();
    const extracted = extractPyInstallerEntries(mockBinary);
    expect(extracted.length).toBeGreaterThanOrEqual(3);

    // 1. Script entry point
    const script = extracted.find((f) => f.name === "main.py");
    expect(script).toBeDefined();
    expect(script?.kind).toBe("script");
    expect(script?.decompressed).toBe(true);
    // Bytecode header must be reconstructed!
    expect(isPythonBytecode(script!.data)).toBe(true);

    // 2. Extracted PYZ module
    const pyzMod = extracted.find((f) => f.name === "app/engine.pyc");
    expect(pyzMod).toBeDefined();
    expect(pyzMod?.kind).toBe("module");
    expect(pyzMod?.decompressed).toBe(true);
    expect(isPythonBytecode(pyzMod!.data)).toBe(true);
    expect(pyzMod?.pythonVersion).toBe("3.10");

    // 3. Binary DLL file
    const dll = extracted.find((f) => f.name === "python310.dll");
    expect(dll).toBeDefined();
    expect(dll?.kind).toBe("binary");
    expect(dll?.data.toString("utf8")).toBe("MOCK_PYTHON_RUNTIME_DLL_PAYLOAD");
  });
});
