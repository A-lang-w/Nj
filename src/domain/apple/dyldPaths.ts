import type {
  DylibTreeEntry,
  DylibTreeView,
  MachoSlice,
} from "./dylibResolution.js";
import { machoCpuSubtypeBase } from "./machoCpuIdentity.js";

const MAX_SYMLINK_HOPS = 32;

export type PathLookup =
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "absent" | "escapes" | "not-file" };

/**
 * Resolve a root-relative path one segment at a time, as `open` would:
 * symlinks are followed inside the root, `..` applies to the real parent,
 * and any escape above the root or through an absolute link stops.
 */
export const resolveTreePath = async (
  view: DylibTreeView,
  input: string,
): Promise<PathLookup> => {
  const pending = segmentsOf(input);
  const resolved: string[] = [];
  let last: DylibTreeEntry | undefined;
  let hops = 0;
  while (pending.length > 0) {
    const segment = pending.shift() ?? "";
    if (segment === ".") continue;
    if (segment === "..") {
      if (resolved.length === 0) return { kind: "escapes" };
      resolved.pop();
      last = { kind: "directory" };
      continue;
    }
    const path = [...resolved, segment].join("/");
    const entry = await view.entry(path);
    if (entry === undefined) return { kind: "absent" };
    if (entry.kind === "symlink") {
      hops += 1;
      if (hops > MAX_SYMLINK_HOPS) return { kind: "absent" };
      if (entry.target.startsWith("/")) return { kind: "escapes" };
      pending.unshift(...segmentsOf(entry.target));
      continue;
    }
    if (entry.kind === "file" && pending.length > 0) return { kind: "absent" };
    resolved.push(segment);
    last = entry;
  }
  return last?.kind === "file"
    ? { kind: "file", path: resolved.join("/") }
    : { kind: "not-file" };
};

const segmentsOf = (path: string): string[] => {
  const segments = path.split("/").filter((segment) => segment !== "");
  // a trailing slash requires a directory, just like a final dot component.
  if (path.endsWith("/")) segments.push(".");
  return segments;
};

export const directoryOf = (path: string): string => {
  const index = path.lastIndexOf("/");
  return index < 0 ? "" : path.slice(0, index);
};

export const joinPath = (directory: string, rest: string): string =>
  directory === "" ? rest : rest === "" ? directory : `${directory}/${rest}`;

export type Expansion =
  | {
      readonly scope: "target";
      /** Source-facing expansion retained in candidate Evidence. */
      readonly path: string;
      /** Root-relative lookup identity when `path` is an absolute source path. */
      readonly lookupPath?: string;
    }
  | { readonly scope: "outside"; readonly path: string }
  | { readonly scope: "undetermined"; readonly path: string };

/** Expand one dyld path prefix relative to its owning image. */
export const expandPrefix = (
  raw: string,
  context: {
    readonly ownerDirectory: string;
    readonly executable: string | null;
    readonly rootRelativePath: (absolutePath: string) => string | undefined;
  },
): Expansion => {
  // Load-command paths can contain line terminators; the suffix is not a text line.
  const variable = /^@(executable_path|loader_path)(?:\/(.*))?$/su.exec(raw);
  if (variable !== null) {
    const rest = variable[2] ?? "";
    if (variable[1] === "loader_path")
      return { scope: "target", path: joinPath(context.ownerDirectory, rest) };
    return context.executable === null
      ? { scope: "undetermined", path: raw }
      : {
          scope: "target",
          path: joinPath(directoryOf(context.executable), rest),
        };
  }
  if (raw.startsWith("/")) {
    const lookupPath = context.rootRelativePath(raw);
    return lookupPath === undefined
      ? { scope: "outside", path: raw }
      : { scope: "target", path: raw, lookupPath };
  }
  return { scope: "undetermined", path: raw };
};

/**
 * Slices a process may load, best first, following dyld's graded
 * architectures: an x86_64h process also accepts generic x86_64.
 */

const COMPATIBLE_ARCHITECTURES: Readonly<Record<string, readonly string[]>> = {
  x86_64h: ["x86_64h", "x86_64"],
};

/** CPU_TYPE_ARM: 32-bit ARM, whose subtypes all share the display name "arm". */
const CPU_TYPE_ARM = 12;

/**
 * 32-bit ARM slices a process of a given subtype accepts, best first,
 * following dyld's graded architectures: an ARMv7s process prefers an
 * ARMv7s slice and falls back to ARMv7, regardless of FAT order.
 */
const ARM32_SUBTYPE_PREFERENCE: Readonly<Record<number, readonly number[]>> = {
  11: [11, 9], // ARMv7s: v7s, then v7
  9: [9], // ARMv7: v7 only
};

const arm32Slice = (
  slices: readonly MachoSlice[],
  process: Pick<MachoSlice, "cpu_subtype">,
): MachoSlice | undefined => {
  const arm = slices.filter((item) => item.cpu_type === CPU_TYPE_ARM);
  const preference =
    ARM32_SUBTYPE_PREFERENCE[machoCpuSubtypeBase(process.cpu_subtype)];
  if (preference === undefined) {
    // Unknown loader policy: choose only when the slices cannot disagree.
    const subtypes = new Set(
      arm.map((item) => machoCpuSubtypeBase(item.cpu_subtype)),
    );
    return subtypes.size <= 1 ? arm[0] : undefined;
  }
  for (const subtype of preference) {
    const slice = arm.find(
      (item) => machoCpuSubtypeBase(item.cpu_subtype) === subtype,
    );
    if (slice !== undefined) return slice;
  }
  return undefined;
};

export const compatibleSlice = (
  slices: readonly MachoSlice[],
  process: Pick<MachoSlice, "architecture" | "cpu_type" | "cpu_subtype">,
): MachoSlice | undefined => {
  if (process.cpu_type === CPU_TYPE_ARM) return arm32Slice(slices, process);
  for (const architecture of COMPATIBLE_ARCHITECTURES[process.architecture] ?? [
    process.architecture,
  ]) {
    const slice = slices.find(
      (item) =>
        item.architecture === architecture &&
        (process.architecture !== "arm64e" ||
          (item.cpu_type === process.cpu_type &&
            machoCpuSubtypeBase(item.cpu_subtype) ===
              machoCpuSubtypeBase(process.cpu_subtype))),
    );
    if (slice !== undefined) return slice;
  }
  return undefined;
};
