import { open } from "node:fs/promises";
import { posix } from "node:path";

/** Memory facts for the cgroup v2 group that holds this process. */
export interface LinuxCgroupMemoryState {
  /** Group path from `/proc/self/cgroup`, relative to the cgroup2 mount. */
  readonly path: string;
  /**
   * Hierarchical `oom_kill` count from `memory.events`. The kernel charges an
   * OOM kill to the victim's group and every ancestor, so a kill anywhere in
   * this process's subtree raises it whichever limit was reached.
   */
  readonly oomKills: number;
  /** `memory.max` in bytes; null when the group sets no limit or omits the file. */
  readonly memoryMax: number | null;
}

const KERNEL_FILE_BYTES = 16 * 1024;

/** Read the single cgroup v2 (`0::`) row of one `/proc/<pid>/cgroup` record. */
export const parseLinuxCgroupV2Path = (value: string): string | undefined => {
  let path: string | undefined;
  for (const line of value.split("\n")) {
    if (!line.startsWith("0::")) continue;
    if (path !== undefined) return undefined;
    path = line.slice(3);
  }
  if (path === undefined || !path.startsWith("/")) return undefined;
  return path.split("/").includes("..") ? undefined : path;
};

/** Read the single `oom_kill` counter of one cgroup v2 `memory.events` file. */
export const parseLinuxCgroupOomKills = (value: string): number | undefined => {
  let count: number | undefined;
  for (const line of value.split("\n")) {
    const match = /^oom_kill ([0-9]+)$/u.exec(line);
    if (match === null) continue;
    if (count !== undefined) return undefined;
    count = Number(match[1]);
  }
  return count !== undefined && Number.isSafeInteger(count) ? count : undefined;
};

/** Read one cgroup v2 `memory.max` file; `max` means no limit. */
export const parseLinuxCgroupMemoryMax = (
  value: string,
): number | null | undefined => {
  const token = value.trim();
  if (token === "max") return null;
  if (!/^[0-9]+$/u.test(token)) return undefined;
  const bytes = Number(token);
  return Number.isSafeInteger(bytes) ? bytes : undefined;
};

/**
 * Observe this process's cgroup v2 memory group. Unavailable on other
 * platforms, under cgroup v1, or when the files are unreadable.
 */
export const readLinuxCgroupMemoryState = async (
  options: {
    readonly platform?: NodeJS.Platform;
    readonly procCgroupPath?: string;
    readonly mountRoot?: string;
  } = {},
): Promise<LinuxCgroupMemoryState | undefined> => {
  if ((options.platform ?? process.platform) !== "linux") return undefined;
  const membership = await readKernelFile(
    options.procCgroupPath ?? "/proc/self/cgroup",
  );
  const path =
    membership === undefined ? undefined : parseLinuxCgroupV2Path(membership);
  if (path === undefined) return undefined;
  const group = posix.join(options.mountRoot ?? "/sys/fs/cgroup", path);
  const events = await readKernelFile(posix.join(group, "memory.events"));
  const oomKills =
    events === undefined ? undefined : parseLinuxCgroupOomKills(events);
  if (oomKills === undefined) return undefined;
  const limit = await readKernelFile(posix.join(group, "memory.max"));
  return {
    path,
    oomKills,
    memoryMax:
      limit === undefined ? null : (parseLinuxCgroupMemoryMax(limit) ?? null),
  };
};

/** Read a small kernel report with a fixed allocation; absent on any failure. */
const readKernelFile = async (path: string): Promise<string | undefined> => {
  try {
    const handle = await open(path, "r");
    try {
      const buffer = Buffer.alloc(KERNEL_FILE_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      return bytesRead === buffer.length
        ? undefined
        : buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
};
