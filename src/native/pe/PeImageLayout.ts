import { err, ok, type Result } from "../../domain/result.js";

/**
 * Owned PE header, section-table and data-directory facts.
 *
 * This module is the single reader of PE section-table structure. Consumers
 * such as `PeResourceLayout` and `PeExceptionDirectory` take a layout from
 * here rather than walking the headers again, so section bounds have one
 * interpretation in the product.
 *
 * OBSERVED-only: every value below is read verbatim from the image. The layout
 * states what the file declares; it does not claim the declarations are
 * consistent with each other beyond the checks named in `code`.
 */

/** One PE section's declared layout, exactly as the image states it. */
export interface PeSection {
  /** Null-padded section name with its trailing NUL bytes removed. */
  readonly name: string;
  /** VirtualAddress: the RVA of the section's first byte. */
  readonly rva: number;
  /** VirtualSize of the mapped image; linkers may leave this 0. */
  readonly virtualSize: number;
  /** PointerToRawData: file offset of the section's raw bytes. */
  readonly offset: number;
  /** SizeOfRawData: initialized file bytes, including alignment padding. */
  readonly size: number;
}

/** Why a PE image layout cannot be trusted, kept distinct from its message. */
export type PeLayoutFailureCode =
  | "not-a-pe"
  | "truncated-header"
  | "unsupported-optional-header"
  | "invalid-size-of-headers"
  | "section-rva-overflow"
  | "section-overlaps-headers"
  | "overlapping-sections";

/** A tagged layout failure: `code` for branching, `reason` for a human. */
export interface PeLayoutFailure {
  readonly code: PeLayoutFailureCode;
  readonly reason: string;
}

/** One Data Directory entry as declared; `null` when absent or undeclared. */
export interface PeDataDirectory {
  readonly rva: number;
  readonly size: number;
}

const MZ_SIGNATURE = 0x5a4d;
const PE_SIGNATURE = 0x4550;
const DOS_HEADER_BYTES = 64;
const PE_POINTER_OFFSET = 60;
const COFF_HEADER_BYTES = 24;
const SECTION_HEADER_BYTES = 40;
const DATA_DIRECTORY_BYTES = 8;
const SECTION_COUNT_OFFSET = 6;
const OPTIONAL_HEADER_SIZE_OFFSET = 20;
const MACHINE_OFFSET = 4;
const SECTION_TABLE_OFFSET = 6;
const SIZE_OF_IMAGE_OFFSET = 56;
const SIZE_OF_HEADERS_OFFSET = 60;
const PE32_MAGIC = 0x10b;
const PE32_PLUS_MAGIC = 0x20b;
/** NumberOfRvaAndSizes sits just below the directory array in both formats. */
const DIRECTORY_COUNT_OFFSET = 92;
const DIRECTORY_COUNT_OFFSET_PLUS = 108;
/** RVAs are 32-bit; a section ending past 2^32 has no representable range. */
const RVA_SPACE = 0x1_0000_0000;

/** Data Directory index of the Exception Directory (`.pdata`). */
export const PE_EXCEPTION_DIRECTORY_INDEX = 3;

/**
 * Header bytes worth reading before trusting `e_lfanew`. A PE header that
 * starts beyond this needs a wider window; `readPeHeaderWindow` handles that.
 */
export const PE_HEADER_WINDOW_BYTES = 0x1000;

/** Refuse a header span larger than this rather than allocating from a claim. */
const MAX_HEADER_BYTES = 0x4000;

/**
 * RVA ownership follows the declared virtual extent, not the raw size. Raw
 * bytes include file-alignment padding that no RVA addresses; a loader may
 * round the tail up to a page, but those bytes are outside the declared
 * section.
 */
export const peVirtualExtent = (section: PeSection): number =>
  section.virtualSize === 0 ? section.size : section.virtualSize;

/** A file-backed byte range resolved through the section table. */
export interface PeFileRange {
  readonly offset: number;
  readonly length: number;
}

export interface PeImageLayout {
  readonly format: "pe32" | "pe32-plus";
  readonly machine: number;
  /** True length of the artifact these headers describe, when known. */
  readonly fileSize: number;
  readonly sizeOfHeaders: number;
  readonly sizeOfImage: number;
  readonly sectionCount: number;
  /** NumberOfRvaAndSizes actually present in this optional header. */
  readonly directoryCount: number;
  /** Offset of the PE signature within the artifact. */
  readonly peOffset: number;
  /** Offset of the optional header within the artifact. */
  readonly optionalOffset: number;
  /** Optional-header magic: `0x10b` for PE32, `0x20b` for PE32+. */
  readonly optionalMagic: number;
  /** Offset of the data-directory array within the optional header. */
  readonly directoriesOffset: number;
  readonly sections: readonly PeSection[];
  /**
   * Declared directory `index`, or `null` when the optional header does not
   * carry that many entries. A returned `{ rva: 0, size: 0 }` is a real
   * declaration of an absent directory; consumers decide what absent means
   * for their own feature rather than having it decided here.
   */
  directory(index: number): PeDataDirectory | null;
  /**
   * Byte offset of directory `index` inside the optional header, reported
   * whether or not that entry is declared. Consumers use it to cite where a
   * declaration was read from, so it must not depend on the entry's value.
   */
  directoryOffset(index: number): number;
  /**
   * The one section owning `rva` under declared virtual extents. `null` when
   * no section covers it or two sections overlap it — an ambiguous owner is
   * reported as absent rather than resolved by table order.
   */
  sectionAt(rva: number): PeSection | null;
  /**
   * Resolve `size` bytes at `rva` to file bytes that are entirely inside one
   * section's virtual extent *and* file-backed in the same section.
   */
  fileRange(rva: number, size: number): Result<PeFileRange, PeLayoutFailure>;
}

const layoutFailure = (
  code: PeLayoutFailureCode,
  reason: string,
): Result<never, PeLayoutFailure> => err({ code, reason });

/**
 * Parse PE headers and the section table from a header window.
 *
 * `bytes` may hold only the leading window of a larger file; `fileSize` is the
 * file's true length and is what bounds section raw ranges. Header fields must
 * themselves be inside `bytes`. Section *contents* are not read here.
 */
export const readPeImageLayout = (
  bytes: Buffer,
  fileSize: number = bytes.length,
): Result<PeImageLayout, PeLayoutFailure> => {
  if (bytes.length < DOS_HEADER_BYTES)
    return layoutFailure(
      "truncated-header",
      "PE image is shorter than its MZ header.",
    );
  if (bytes.readUInt16LE(0) !== MZ_SIGNATURE)
    return layoutFailure("not-a-pe", "Expected an MZ PE image.");
  if (fileSize < DOS_HEADER_BYTES)
    return layoutFailure(
      "truncated-header",
      "PE image is shorter than its MZ header.",
    );
  const pe = bytes.readUInt32LE(PE_POINTER_OFFSET);
  if (pe > fileSize - COFF_HEADER_BYTES || pe < DOS_HEADER_BYTES)
    return layoutFailure(
      "truncated-header",
      "PE range is outside the artifact.",
    );
  if (pe > bytes.length - COFF_HEADER_BYTES)
    return layoutFailure(
      "truncated-header",
      "PE range is outside the artifact.",
    );
  if (bytes.readUInt32LE(pe) !== PE_SIGNATURE)
    return layoutFailure("not-a-pe", "Expected a PE signature.");
  const machine = bytes.readUInt16LE(pe + MACHINE_OFFSET);
  const sectionCount = bytes.readUInt16LE(pe + SECTION_COUNT_OFFSET);
  const optionalSize = bytes.readUInt16LE(pe + OPTIONAL_HEADER_SIZE_OFFSET);
  const optional = pe + COFF_HEADER_BYTES;
  if (optional > fileSize || optionalSize > fileSize - optional)
    return layoutFailure(
      "truncated-header",
      "PE range is outside the artifact.",
    );
  if (optional > bytes.length || optionalSize > bytes.length - optional)
    return layoutFailure(
      "truncated-header",
      "PE range is outside the artifact.",
    );
  if (optionalSize < 64)
    return layoutFailure("truncated-header", "Truncated PE optional header.");
  const magic = bytes.readUInt16LE(optional);
  if (magic !== PE32_MAGIC && magic !== PE32_PLUS_MAGIC)
    return layoutFailure(
      "unsupported-optional-header",
      "Unsupported PE optional header magic.",
    );
  const countAt =
    magic === PE32_PLUS_MAGIC
      ? DIRECTORY_COUNT_OFFSET_PLUS
      : DIRECTORY_COUNT_OFFSET;
  const directoriesAt = countAt + 4;
  if (optionalSize < directoriesAt)
    return layoutFailure(
      "truncated-header",
      "Truncated PE data directory count.",
    );
  const directoryCount = bytes.readUInt32LE(optional + countAt);
  if (
    directoryCount >
    Math.floor((optionalSize - directoriesAt) / DATA_DIRECTORY_BYTES)
  )
    return layoutFailure(
      "unsupported-optional-header",
      "PE directory count exceeds its optional header.",
    );
  const sizeOfHeaders = bytes.readUInt32LE(optional + SIZE_OF_HEADERS_OFFSET);
  const sizeOfImage = bytes.readUInt32LE(optional + SIZE_OF_IMAGE_OFFSET);
  const table = optional + optionalSize;
  if (
    table > fileSize ||
    sectionCount > (fileSize - table) / SECTION_HEADER_BYTES
  )
    return layoutFailure(
      "truncated-header",
      "PE range is outside the artifact.",
    );
  if (
    table > bytes.length ||
    sectionCount > (bytes.length - table) / SECTION_HEADER_BYTES
  )
    return layoutFailure(
      "truncated-header",
      "PE range is outside the artifact.",
    );
  if (
    sectionCount * SECTION_HEADER_BYTES > Number.MAX_SAFE_INTEGER ||
    sizeOfHeaders < table + sectionCount * SECTION_HEADER_BYTES ||
    sizeOfHeaders > fileSize
  )
    return layoutFailure(
      "invalid-size-of-headers",
      "Invalid PE SizeOfHeaders.",
    );
  const sections: PeSection[] = [];
  for (let index = 0; index < sectionCount; index++) {
    const at = table + index * SECTION_HEADER_BYTES;
    const section: PeSection = {
      name: bytes.toString("latin1", at, at + 8).replace(/\0+$/u, ""),
      virtualSize: bytes.readUInt32LE(at + 8),
      rva: bytes.readUInt32LE(at + 12),
      size: bytes.readUInt32LE(at + 16),
      offset: bytes.readUInt32LE(at + 20),
    };
    if (section.rva + peVirtualExtent(section) > RVA_SPACE)
      return layoutFailure(
        "section-rva-overflow",
        "PE section RVA range overflows.",
      );
    if (section.size > 0) {
      if (section.offset > fileSize || section.size > fileSize - section.offset)
        return layoutFailure(
          "truncated-header",
          "PE range is outside the artifact.",
        );
      if (section.offset < sizeOfHeaders)
        return layoutFailure(
          "section-overlaps-headers",
          "PE section raw bytes overlap headers.",
        );
    }
    sections.push(section);
  }
  const backed = sections
    .filter(({ size }) => size > 0)
    .sort((left, right) => left.offset - right.offset);
  for (let index = 1; index < backed.length; index++) {
    const previous = backed[index - 1];
    const current = backed[index];
    if (
      previous !== undefined &&
      current !== undefined &&
      current.offset < previous.offset + previous.size
    )
      return layoutFailure(
        "overlapping-sections",
        "PE sections have overlapping raw file ranges.",
      );
  }
  const sectionAt = (rva: number): PeSection | null => {
    let found: PeSection | null = null;
    for (const section of sections) {
      if (rva >= section.rva && rva - section.rva < peVirtualExtent(section)) {
        if (found !== null) return null;
        found = section;
      }
    }
    return found;
  };
  return ok({
    format:
      magic === PE32_PLUS_MAGIC ? ("pe32-plus" as const) : ("pe32" as const),
    machine,
    fileSize,
    sizeOfHeaders,
    sizeOfImage,
    sectionCount,
    directoryCount,
    peOffset: pe,
    optionalOffset: optional,
    optionalMagic: magic,
    directoriesOffset: directoriesAt,
    sections,
    directory(index: number): PeDataDirectory | null {
      if (index < 0 || index >= directoryCount) return null;
      const at = optional + directoriesAt + index * DATA_DIRECTORY_BYTES;
      if (at + DATA_DIRECTORY_BYTES > optional + optionalSize) return null;
      return { rva: bytes.readUInt32LE(at), size: bytes.readUInt32LE(at + 4) };
    },
    directoryOffset(index: number): number {
      return optional + directoriesAt + index * DATA_DIRECTORY_BYTES;
    },
    sectionAt,
    fileRange(rva: number, size: number): Result<PeFileRange, PeLayoutFailure> {
      if (
        !Number.isSafeInteger(rva) ||
        !Number.isSafeInteger(size) ||
        rva < 0 ||
        size < 0
      )
        return layoutFailure(
          "truncated-header",
          "PE RVA range is not a byte interval.",
        );
      if (rva + size > RVA_SPACE)
        return layoutFailure("section-rva-overflow", "PE RVA range overflows.");
      if (size === 0) return ok({ offset: 0, length: 0 });
      const section = sectionAt(rva);
      if (section === null)
        return layoutFailure(
          "truncated-header",
          "PE RVA has no unambiguous section mapping.",
        );
      const within = rva - section.rva;
      const extent = peVirtualExtent(section);
      if (size > extent - within)
        return layoutFailure(
          "truncated-header",
          "PE range leaves its section's virtual size.",
        );
      if (within > section.size || size > section.size - within)
        return layoutFailure(
          "truncated-header",
          "PE range is not entirely file-backed.",
        );
      const offset = section.offset + within;
      if (offset > fileSize || size > fileSize - offset)
        return layoutFailure(
          "truncated-header",
          "PE range is outside the artifact.",
        );
      return ok({ offset, length: size });
    },
  });
};

/**
 * Bytes needed to hold this image's headers, or `undefined` when the declared
 * MZ pointer is already unusable. Lets a caller size one bounded header read
 * instead of guessing a window.
 */
export const peHeaderBytes = (bytes: Buffer): number | undefined => {
  if (bytes.length < DOS_HEADER_BYTES) return undefined;
  if (bytes.readUInt16LE(0) !== MZ_SIGNATURE) return undefined;
  const pe = bytes.readUInt32LE(PE_POINTER_OFFSET);
  if (pe > MAX_HEADER_BYTES || pe < DOS_HEADER_BYTES) return undefined;
  if (bytes.length < pe + COFF_HEADER_BYTES + 4) return undefined;
  const sectionCount = bytes.readUInt16LE(pe + SECTION_COUNT_OFFSET);
  const optionalSize = bytes.readUInt16LE(pe + OPTIONAL_HEADER_SIZE_OFFSET);
  const needed =
    pe + COFF_HEADER_BYTES + optionalSize + sectionCount * SECTION_HEADER_BYTES;
  if (needed > MAX_HEADER_BYTES) return undefined;
  return Math.max(PE_HEADER_WINDOW_BYTES, needed);
};
