import { ArtifactReaderFailure } from "../../artifacts/ArtifactReader.js";
import {
  peVirtualExtent,
  readPeImageLayout,
  type PeSection,
} from "./PeImageLayout.js";

/** Data Directory index of the resource directory. */
const RESOURCE_DIRECTORY_INDEX = 2;

export const peFailure = (message: string): never => {
  throw new ArtifactReaderFailure("format", message);
};

export const requirePeRange = (
  bytes: Buffer,
  offset: number,
  length: number,
): void => {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset > bytes.length - length
  )
    peFailure(
      `PE range ${String(offset)} + ${String(length)} leaves the artifact.`,
    );
};

/**
 * Header admission and unambiguous file-backed RVA mapping for the resource
 * tree, independent of section names.
 *
 * PE header, section-table and data-directory facts come from the shared
 * `readPeImageLayout` owner; only the resource-specific mapping rules and
 * their messages are decided here.
 */
export const readPeResourceLayout = (bytes: Buffer) => {
  const parsed = readPeImageLayout(bytes);
  if (!parsed.ok) return peFailure(parsed.error.reason);
  const layout = parsed.value;
  const { sections } = layout;
  const headerSize = layout.sizeOfHeaders;
  const map = (rva: number, size: number): number => {
    if (rva + size > 0x100000000) peFailure("Resource RVA range overflows.");
    const candidates = sections.filter(
      (section) =>
        rva >= section.rva && rva - section.rva < peVirtualExtent(section),
    );
    if (rva < headerSize) {
      if (
        sections.some(
          (section) =>
            section.rva < rva + size &&
            section.rva + peVirtualExtent(section) > rva,
        ) ||
        size > headerSize - rva
      )
        peFailure("Ambiguous resource header RVA mapping.");
      requirePeRange(bytes, rva, size);
      return rva;
    }
    if (candidates.length !== 1)
      peFailure("Resource RVA has missing or overlapping section mappings.");
    const section = candidates[0];
    if (section === undefined) return peFailure("Missing resource section.");
    const within = rva - section.rva;
    if (size > peVirtualExtent(section) - within)
      peFailure("Resource range leaves its section's virtual size.");
    if (within > section.size || size > section.size - within)
      peFailure("Resource range is not entirely file-backed in one section.");
    // A second section starting inside the requested interval is ambiguous too.
    if (
      sections.some(
        (other: PeSection) =>
          other !== section &&
          other.rva < rva + size &&
          other.rva + peVirtualExtent(other) > rva,
      )
    )
      peFailure("Resource interval intersects overlapping virtual sections.");
    const offset = section.offset + within;
    requirePeRange(bytes, offset, size);
    return offset;
  };
  const resource = layout.directory(RESOURCE_DIRECTORY_INDEX);
  const rva = resource?.rva ?? 0;
  const size = resource?.size ?? 0;
  if ((rva === 0) !== (size === 0))
    peFailure("Inconsistent PE resource directory RVA/size.");
  return {
    format: layout.format,
    machine: layout.machine,
    directoryAt: layout.directoryOffset(RESOURCE_DIRECTORY_INDEX),
    rva,
    size,
    map,
  };
};
