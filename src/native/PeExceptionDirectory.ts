import { open } from "node:fs/promises";
import { err, ok, type Result } from "../domain/result.js";
import {
  PE_EXCEPTION_DIRECTORY_INDEX,
  PE_HEADER_WINDOW_BYTES,
  peHeaderBytes,
  peVirtualExtent,
  readPeImageLayout,
  type PeImageLayout,
  type PeLayoutFailure,
  type PeLayoutFailureCode,
} from "./pe/PeImageLayout.js";

/**
 * Measured function extents from a PE image's Exception Directory (`.pdata`).
 *
 * A Windows x64 `RUNTIME_FUNCTION` states the exact `[BeginAddress,
 * EndAddress)` of every function the compiler emitted unwind data for. Those
 * bounds are measured by the toolchain, unlike boundaries recovered by
 * scanning for prologue bytes, so a consumer can say which it used instead of
 * guessing mid-function.
 *
 * Execution-free: this reads a file's declared bytes. It runs nothing, links
 * nothing, and derives nothing about program behaviour.
 *
 * ABSENCE IS A FACT ABOUT THE FILE, NOT ABOUT THE FUNCTIONS. An image may
 * declare no Exception Directory, or declare one this reader cannot bound.
 * Both are tagged failures carrying a reason; neither is reported as a
 * successful zero-extent answer, which would read as "this binary has no
 * functions".
 */

/** One measured function extent: RVAs, `[begin, end)`, `end` exclusive. */
export interface PeFunctionExtent {
  /** BeginAddress RVA: first byte of the function. */
  readonly begin: number;
  /** EndAddress RVA: one past the last byte of the function. */
  readonly end: number;
}

/**
 * `RUNTIME_FUNCTION` as x86 and x64 emit it: three 32-bit fields, 12 bytes.
 * ARM and ARM64 pad or extend this record differently, so those machines are
 * refused rather than measured with the wrong stride.
 */
export const PE_RUNTIME_FUNCTION_BYTES = 12;

const IMAGE_FILE_MACHINE_I386 = 0x014c;
const IMAGE_FILE_MACHINE_AMD64 = 0x8664;
const RVA_SPACE = 0x1_0000_0000;

/** Why `.pdata` could not be measured, kept distinct from its message. */
export type PeExceptionFailureCode =
  | PeLayoutFailureCode
  | "unsupported-machine"
  | "exception-directory-absent"
  | "exception-directory-inconsistent"
  | "exception-directory-unmapped"
  | "exception-directory-not-file-backed"
  | "exception-directory-empty"
  | "exception-directory-malformed";

/** A tagged `.pdata` failure: `code` for branching, `reason` for a human. */
export interface PeExceptionFailure {
  readonly code: PeExceptionFailureCode;
  readonly reason: string;
}

/** How the Exception Directory sits in the file, resolved through sections. */
export interface PeExceptionDirectoryRange {
  /** Data Directory entry RVA as declared. */
  readonly rva: number;
  /** Data Directory entry Size as declared, before any file bound applies. */
  readonly declaredSize: number;
  /** Whole records the declaration promises, `floor(declaredSize / 12)`. */
  readonly declaredCount: number;
  /** File offset of the first record byte. */
  readonly offset: number;
  /**
   * Bytes actually readable at `offset`, bounded by the section table and the
   * file length. Less than `declaredSize` means a partial read, never a
   * complete one.
   */
  readonly available: number;
}

/** Measured extents plus the completeness facts a caller must not assume. */
export interface PeExceptionDirectory {
  readonly format: "pe32" | "pe32-plus";
  /** Records the image declares. An absence signal only; not `entries.length`. */
  readonly declaredCount: number;
  /** Read records ÷ declared records; 1 only when the whole directory was read. */
  readonly coverage: number;
  /** True only when every declared record was read. */
  readonly complete: boolean;
  /** Sorted by `begin`, de-duplicated, `begin >= end` records removed. */
  readonly entries: readonly PeFunctionExtent[];
  /** Declared records whose `begin >= end`, or wholly unreadable. */
  readonly rejectedCount: number;
  /** Records repeating an extent already present. */
  readonly duplicateCount: number;
  /** Extents beginning at an RVA no section maps. */
  readonly unmappedCount: number;
  /** What this measurement does not establish, always populated. */
  readonly limitations: readonly string[];
  /** The extent containing `rva`, or `undefined`. Binary search, no allocation. */
  functionAt(rva: number): PeFunctionExtent | undefined;
  /** Extents intersecting `[rva, rva + size)`, in address order. */
  extentsIn(rva: number, size: number): Generator<PeFunctionExtent>;
}

const failure = (
  code: PeExceptionFailureCode,
  reason: string,
): Result<never, PeExceptionFailure> => err({ code, reason });

const at = (values: Uint32Array, index: number): number => values[index] ?? 0;

/** x86 and x64 share one `RUNTIME_FUNCTION` stride; nothing else is assumed. */
const requireMeasurableMachine = (
  layout: PeImageLayout,
): Result<PeImageLayout, PeExceptionFailure> =>
  layout.machine === IMAGE_FILE_MACHINE_I386 ||
  layout.machine === IMAGE_FILE_MACHINE_AMD64
    ? ok(layout)
    : failure(
        "unsupported-machine",
        `PE machine 0x${layout.machine.toString(16).padStart(4, "0")} does not use the ${String(PE_RUNTIME_FUNCTION_BYTES)}-byte RUNTIME_FUNCTION stride this reader measures.`,
      );

/**
 * Resolve Data Directory entry 3 to a file range.
 *
 * The read is bounded by the section table first and the file length second,
 * never by the declared Size alone: a directory may declare more bytes than
 * its section actually carries in the file, and `available` then reports the
 * shorter truth instead of the longer claim.
 */
export const peExceptionDirectoryRange = (
  layout: PeImageLayout,
): Result<PeExceptionDirectoryRange, PeExceptionFailure> => {
  const measurable = requireMeasurableMachine(layout);
  if (!measurable.ok) return measurable;
  const declared = measurable.value.directory(PE_EXCEPTION_DIRECTORY_INDEX);
  if (declared === null || (declared.rva === 0 && declared.size === 0))
    return failure(
      "exception-directory-absent",
      "PE declares no Exception Directory; this is a fact about the file, not about its functions.",
    );
  if ((declared.rva === 0) !== (declared.size === 0))
    return failure(
      "exception-directory-inconsistent",
      `PE declares an Exception Directory RVA of ${String(declared.rva)} with size ${String(declared.size)}.`,
    );
  const section = measurable.value.sectionAt(declared.rva);
  if (section === null)
    return failure(
      "exception-directory-unmapped",
      `Exception Directory RVA 0x${declared.rva.toString(16)} has no unambiguous section mapping.`,
    );
  const within = declared.rva - section.rva;
  if (within > peVirtualExtent(section))
    return failure(
      "exception-directory-unmapped",
      `Exception Directory RVA 0x${declared.rva.toString(16)} lies outside section ${section.name}.`,
    );
  const offset = section.offset + within;
  // Section table first: initialized file bytes bound the read, and the
  // uninitialized virtual tail of a section holds no directory records.
  const sectionBacked = section.size > within ? section.size - within : 0;
  const fileBacked =
    offset >= measurable.value.fileSize
      ? 0
      : measurable.value.fileSize - offset;
  const available = Math.max(
    0,
    Math.min(declared.size, sectionBacked, fileBacked),
  );
  if (available === 0)
    return failure(
      "exception-directory-not-file-backed",
      `Exception Directory RVA 0x${declared.rva.toString(16)} has no file-backed bytes in section ${section.name}.`,
    );
  return ok({
    rva: declared.rva,
    declaredSize: declared.size,
    declaredCount: Math.floor(declared.size / PE_RUNTIME_FUNCTION_BYTES),
    offset,
    available,
  });
};

/**
 * Measure extents from the bytes actually read.
 *
 * Records with `begin >= end` are malformed and excluded rather than trusted;
 * duplicates collapse; the survivors sort by address. Every count is reported
 * so a caller can tell a short read from a sparse one from a clean one.
 */
export const decodePeExceptionDirectory = (
  layout: PeImageLayout,
  range: PeExceptionDirectoryRange,
  records: Uint8Array,
): Result<PeExceptionDirectory, PeExceptionFailure> => {
  const readable = Math.min(
    Math.floor(range.available / PE_RUNTIME_FUNCTION_BYTES),
    Math.floor(records.byteLength / PE_RUNTIME_FUNCTION_BYTES),
  );
  const readCount = Math.max(readable, 0);
  if (readCount === 0)
    return failure(
      "exception-directory-empty",
      `Exception Directory declares ${String(range.declaredCount)} records but no whole record is readable.`,
    );
  const begins = new Uint32Array(readCount);
  const ends = new Uint32Array(readCount);
  const view = new DataView(
    records.buffer,
    records.byteOffset,
    records.byteLength,
  );
  let valid = 0;
  for (let index = 0; index < readCount; index++) {
    const at12 = index * PE_RUNTIME_FUNCTION_BYTES;
    const begin = view.getUint32(at12, true);
    const end = view.getUint32(at12 + 4, true);
    // The format requires BeginAddress below EndAddress. Anything else, including
    // all-zero linker padding, is not a function extent.
    if (begin < end && end <= RVA_SPACE) {
      begins[valid] = begin;
      ends[valid] = end;
      valid++;
    }
  }
  if (valid === 0)
    return failure(
      "exception-directory-malformed",
      `All ${String(readCount)} readable RUNTIME_FUNCTION records had BeginAddress not below EndAddress.`,
    );
  const order = new Uint32Array(valid);
  for (let index = 0; index < valid; index++) order[index] = index;
  order.sort(
    (left, right) =>
      at(begins, left) - at(begins, right) || at(ends, left) - at(ends, right),
  );
  const sortedBegins = new Uint32Array(valid);
  const sortedEnds = new Uint32Array(valid);
  let unique = 0;
  let duplicateCount = 0;
  for (const index of order) {
    const begin = at(begins, index);
    const end = at(ends, index);
    if (
      unique > 0 &&
      at(sortedBegins, unique - 1) === begin &&
      at(sortedEnds, unique - 1) === end
    ) {
      duplicateCount++;
      continue;
    }
    sortedBegins[unique] = begin;
    sortedEnds[unique] = end;
    unique++;
  }
  let unmappedCount = 0;
  for (let index = 0; index < unique; index++)
    if (layout.sectionAt(at(sortedBegins, index)) === null) unmappedCount++;
  const coverage =
    range.declaredCount === 0
      ? 1
      : Math.min(readCount / range.declaredCount, 1);
  const complete = readCount >= range.declaredCount;
  const limitations: string[] = [
    "Extents are the Exception Directory's declared [BeginAddress, EndAddress) intervals. They bound functions that unwind; leaf functions compiled without unwind data are absent, and adjacent coalesced functions are not separated by these records.",
    "Bounds are measured, not symbol-derived. UnwindInfo addresses are read past for validation only and are not interpreted.",
  ];
  if (!complete)
    limitations.push(
      `Partial read: ${String(readCount)} of ${String(range.declaredCount)} declared records were readable at file offset ${String(range.offset)}; the remainder is not file-backed in this image.`,
    );
  const rejectedCount = range.declaredCount - readCount + (readCount - valid);
  if (rejectedCount > 0)
    limitations.push(
      `Rejected ${String(rejectedCount)} of ${String(range.declaredCount)} declared records: ${String(readCount - valid)} with BeginAddress not below EndAddress and ${String(range.declaredCount - readCount)} not readable in the file.`,
    );
  if (duplicateCount > 0)
    limitations.push(
      `Collapsed ${String(duplicateCount)} records repeating an extent already present.`,
    );
  if (unmappedCount > 0)
    limitations.push(
      `${String(unmappedCount)} extents begin at an RVA no section maps; their file bytes are unresolved.`,
    );
  // Last extent whose BeginAddress is at or before `rva`. `begin` is exclusive of
  // the next extent, so an address landing exactly on a BeginAddress belongs to
  // that extent, not to the one before it.
  const lastIndexBeginningAtOrBefore = (rva: number): number => {
    let low = 0;
    let high = unique;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (at(sortedBegins, middle) <= rva) low = middle + 1;
      else high = middle;
    }
    return low - 1;
  };
  let materialized: readonly PeFunctionExtent[] | undefined;
  return ok({
    format: layout.format,
    declaredCount: range.declaredCount,
    coverage,
    complete,
    get entries(): readonly PeFunctionExtent[] {
      // Materialized on demand: a caller that only needs `coverage` or
      // `functionAt` never pays for 100k+ objects.
      if (materialized === undefined) {
        const list: PeFunctionExtent[] = new Array<PeFunctionExtent>(unique);
        for (let index = 0; index < unique; index++)
          list[index] = {
            begin: at(sortedBegins, index),
            end: at(sortedEnds, index),
          };
        materialized = list;
      }
      return materialized;
    },
    rejectedCount,
    duplicateCount,
    unmappedCount,
    limitations,
    functionAt(rva: number): PeFunctionExtent | undefined {
      if (!Number.isSafeInteger(rva) || rva < 0 || rva >= RVA_SPACE)
        return undefined;
      const index = lastIndexBeginningAtOrBefore(rva);
      if (index < 0) return undefined;
      if (rva < at(sortedEnds, index))
        return { begin: at(sortedBegins, index), end: at(sortedEnds, index) };
      return undefined;
    },
    *extentsIn(rva: number, size: number): Generator<PeFunctionExtent> {
      if (!Number.isSafeInteger(rva) || !Number.isSafeInteger(size)) return;
      if (size <= 0 || rva < 0 || rva >= RVA_SPACE) return;
      const stop = Math.min(rva + size, RVA_SPACE);
      // Extents are address-ordered and, as the format produces them, cover
      // disjoint ranges; only the extent at `rva` and those after it can reach
      // into this interval.
      for (
        let index = Math.max(lastIndexBeginningAtOrBefore(rva), 0);
        index < unique;
        index++
      ) {
        const begin = at(sortedBegins, index);
        if (begin >= stop) break;
        const end = at(sortedEnds, index);
        if (end <= rva) continue;
        yield { begin, end };
      }
    },
  });
};

/**
 * Measure `.pdata` from an in-memory image. `bytes` may be only the header
 * window of a larger file when `fileSize` says how long that file is; the
 * directory range is then resolved but its bytes are the caller's to supply
 * through {@link decodePeExceptionDirectory}.
 */
export const parsePeExceptionDirectory = (
  bytes: Buffer,
  fileSize: number = bytes.length,
): Result<PeExceptionDirectory, PeExceptionFailure> => {
  const layout = readPeImageLayout(bytes, fileSize);
  if (!layout.ok) return layout;
  const range = peExceptionDirectoryRange(layout.value);
  if (!range.ok) return range;
  const { offset, available } = range.value;
  const start = Math.max(0, Math.min(offset, bytes.length));
  return decodePeExceptionDirectory(
    layout.value,
    range.value,
    bytes.subarray(start, Math.min(start + available, bytes.length)),
  );
};

/** Read exactly `length` bytes at `position`, or report the short read. */
const readExactly = async (
  handle: Awaited<ReturnType<typeof open>>,
  position: number,
  length: number,
): Promise<Buffer> => {
  const buffer = Buffer.alloc(length);
  let filled = 0;
  while (filled < length) {
    const { bytesRead } = await handle.read(
      buffer,
      filled,
      length - filled,
      position + filled,
    );
    if (bytesRead === 0) break;
    filled += bytesRead;
  }
  return filled === length ? buffer : buffer.subarray(0, filled);
};

/**
 * Measure `.pdata` straight from a file, reading only the headers and the
 * directory range. A multi-hundred-megabyte image is never read whole, so the
 * cost is the 1.5 MB of records this directory actually occupies.
 */
export const inspectPeExceptionDirectory = async (
  path: string,
): Promise<Result<PeExceptionDirectory, PeExceptionFailure>> => {
  const handle = await open(path, "r");
  try {
    const { size: fileSize } = await handle.stat();
    let header = await readExactly(
      handle,
      0,
      Math.min(PE_HEADER_WINDOW_BYTES, fileSize),
    );
    const needed = peHeaderBytes(header);
    if (needed !== undefined && needed > header.length)
      header = await readExactly(handle, 0, Math.min(needed, fileSize));
    const layout = readPeImageLayout(header, fileSize);
    if (!layout.ok) return layout;
    const range = peExceptionDirectoryRange(layout.value);
    if (!range.ok) return range;
    const records = await readExactly(
      handle,
      range.value.offset,
      range.value.available,
    );
    return decodePeExceptionDirectory(layout.value, range.value, records);
  } finally {
    await handle.close();
  }
};
