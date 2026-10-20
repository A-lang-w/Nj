import { createReadStream, createWriteStream } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  rename,
  rm,
  utimes,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";

import { z } from "zod";

import {
  requireWindowsNativeAuthority,
  type WindowsNativeAuthority,
} from "../../windows/WindowsNativeLoader.js";
import { GhidraProjectCacheError } from "./GhidraProjectCacheTypes.js";

const nativeIdentitySchema = z
  .object({ privateDacl: z.literal(true) })
  .passthrough();
const createdRuntimeSchema = z
  .object({ path: z.string().min(1), handle: z.unknown() })
  .passthrough();

/** Name of the durable directory created inside a native runtime root. */
const DURABLE_ROOT_LEAF = "root";

/** Native operations that establish and verify a durable private cache root. */
export interface GhidraProjectCacheRootHost {
  /**
   * Create a private directory at `root` and return its path.
   *
   * The directory must carry a protected, owner-only DACL and must not stay
   * sealed by an open native handle: Windows refuses a path-based rename into
   * a sealed directory, so a sealed root would refuse the stored projects the
   * store moves into it and the entries it publishes.
   */
  createPrivateDirectory(root: string): Promise<string>;
  /** Throw unless `path` is an owner-only directory with a protected DACL. */
  verifyPrivateDirectory(path: string): unknown;
}

/**
 * What preparing the cache root did.
 *
 * A root that native verification refused is rebuilt as a private directory
 * rather than disabling the cache, so a caller can report the repair and the
 * stored projects that survived it.
 */
export type GhidraProjectCacheRootPreparation =
  | { readonly status: "ready" }
  | {
      /** A root that was not owner-only was rebuilt as a private directory. */
      readonly status: "repaired";
      /** The stored children carried over from the previous root. */
      readonly preservedEntries: number;
      /**
       * The set-aside root that survived the rebuild. It still holds a copy
       * of the stored projects that the principals its DACL admits can read,
       * so it is reported instead of left unmentioned.
       */
      readonly leftoverRoot?: string;
    };

const systemRootHost = (): GhidraProjectCacheRootHost => {
  const native = (): WindowsNativeAuthority => requireWindowsNativeAuthority();
  return {
    async createPrivateDirectory(root: string): Promise<string> {
      const authority = native();
      const observed = authority.call("runtime_create", [
        dirname(root),
        "rea-ghidra-cache-",
      ]);
      const runtime = createdRuntimeSchema.safeParse(observed);
      if (!runtime.success)
        throw new Error(
          `REA Windows native runtime root is invalid: ${runtime.error.message}`,
        );
      try {
        // The runtime root stays sealed by the handle that owns it. A child
        // created relative to the runtime root carries the same private DACL
        // and is not sealed, so the durable directory can be written by path.
        authority.call("runtime_mkdir", [
          runtime.data.handle,
          DURABLE_ROOT_LEAF,
        ]);
        await rename(join(runtime.data.path, DURABLE_ROOT_LEAF), root);
        return root;
      } finally {
        // The runtime root is empty once the durable directory is in place.
        // Closing it releases the native handles without touching the cache.
        try {
          authority.call("runtime_close", [runtime.data.handle]);
        } catch {
          // The handles are released when the runtime wrapper is collected.
        }
      }
    },
    verifyPrivateDirectory(path: string): unknown {
      const verified = native().call("cutter_bridge_verify_directory", [path]);
      nativeIdentitySchema.parse(verified);
      return verified;
    },
  } satisfies GhidraProjectCacheRootHost;
};

const isNotFound = (cause: unknown): boolean =>
  typeof cause === "object" &&
  cause !== null &&
  "code" in cause &&
  cause.code === "ENOENT";

const rootError = (
  message: string,
  path: string,
  cause?: unknown,
): GhidraProjectCacheError =>
  new GhidraProjectCacheError(
    "io",
    message,
    path,
    cause === undefined ? undefined : { cause },
  );

const assertDirectory = async (root: string): Promise<void> => {
  const stats = await lstat(root).catch((cause: unknown) => {
    if (isNotFound(cause))
      throw rootError("Ghidra project cache root does not exist", root, cause);
    throw cause;
  });
  if (!stats.isDirectory() || stats.isSymbolicLink())
    throw rootError(
      "Ghidra project cache root must be a directory, not a link",
      root,
    );
};

const ensurePosixRoot = async (root: string): Promise<void> => {
  await mkdir(root, { recursive: true, mode: 0o700 });
  await assertDirectory(root);
  // mkdir does not tighten an existing directory. Only POSIX exposes owner
  // bits to Node, and a widened root would expose every stored project.
  if (process.getuid === undefined) return;
  const before = await lstat(root);
  if ((before.mode & 0o077) === 0) return;
  await chmod(root, 0o700);
  const after = await lstat(root);
  if ((after.mode & 0o077) !== 0)
    throw rootError(
      "Ghidra project cache root permissions could not be made owner-only",
      root,
    );
};

/**
 * Move the current root aside so the configured path is free while the
 * replacement is built.
 *
 * The previous root keeps the stored projects until the replacement is in
 * place, so a failed repair restores it instead of losing the cache.
 */
const quarantineRoot = async (root: string): Promise<string> => {
  const parent = dirname(root);
  const name = basename(root);
  for (let attempt = 1; attempt <= 64; attempt += 1) {
    const candidate = join(parent, `${name}.previous-${attempt}`);
    const taken = await lstat(candidate).catch(() => undefined);
    if (taken !== undefined) continue;
    await rename(root, candidate);
    return candidate;
  }
  throw rootError(
    "Ghidra project cache root could not be set aside for repair",
    root,
  );
};

/**
 * Copy every child of `from` into `to`.
 *
 * The copy is deliberate. A relocated child keeps the permissions it was
 * created with, so a child of a shared root stays readable by the principals
 * its DACL admits even inside a private root: Windows accounts hold
 * SeChangeNotifyPrivilege, which bypasses the traverse check on the private
 * parent. A copy created inside the private root inherits the root's
 * owner-only DACL, so the preserved projects are private like the root that
 * holds them.
 */
const copyDirectoryContent = async (
  from: string,
  to: string,
): Promise<number> => {
  const names = await readdir(from);
  for (const name of names) {
    await copyCacheEntry(join(from, name), join(to, name));
  }
  return names.length;
};

/** Copy one stored entry into the private root, refusing what it cannot hold. */
const copyCacheEntry = async (from: string, to: string): Promise<void> => {
  const stats = await lstat(from);
  if (stats.isSymbolicLink())
    throw rootError(
      "Ghidra project cache root holds a link that cannot be copied into a private directory",
      from,
    );
  if (stats.isDirectory()) {
    await mkdir(to, { recursive: true, mode: 0o700 });
    for (const name of await readdir(from))
      await copyCacheEntry(join(from, name), join(to, name));
    await utimes(to, stats.atime, stats.mtime);
    return;
  }
  if (!stats.isFile())
    throw rootError(
      "Ghidra project cache root holds an entry that cannot be copied into a private directory",
      from,
    );
  await pipeline(
    createReadStream(from),
    createWriteStream(to, { flags: "wx", mode: 0o600 }),
  );
  await utimes(to, stats.atime, stats.mtime);
};

/** What rebuilding a root that was not owner-only achieved. */
interface WindowsRootRepair {
  /** The stored children copied into the private replacement. */
  readonly preserved: number;
  /** The set-aside root that survived the rebuild, when one did. */
  readonly leftover: string | undefined;
}

/**
 * Rebuild a root that native verification refused as a private directory.
 *
 * A root that is not owner-only keeps every stored project readable by the
 * principals its DACL admits, and the store cannot use it at all. The stored
 * children are copied into a private root that replaces it, so the cache
 * keeps working instead of being disabled for the whole session, and the
 * copies are private like the root that holds them.
 */
const replaceWindowsRoot = async (
  root: string,
  host: GhidraProjectCacheRootHost,
): Promise<WindowsRootRepair> => {
  const previous = await quarantineRoot(root);
  try {
    await host.createPrivateDirectory(root);
  } catch (failure: unknown) {
    throw await rebuildFailure(root, previous, failure);
  }
  try {
    // The copy writes into the replacement, so the destination must be the
    // directory the native boundary created and not a link in its place.
    await assertDirectory(root);
  } catch (failure: unknown) {
    throw await rebuildFailure(root, previous, failure);
  }
  try {
    // The replacement is verified before a stored project is copied into it,
    // so a root that is not owner-only never receives the preserved projects.
    host.verifyPrivateDirectory(root);
  } catch (verification: unknown) {
    const restored = await restoreQuarantinedRoot(previous, root);
    throw rootError(
      repairFailureMessage(
        "Ghidra project cache root could not be verified as owner-only",
        previous,
        restored,
      ),
      root,
      verification,
    );
  }
  let preserved: number;
  try {
    preserved = await copyDirectoryContent(previous, root);
  } catch (failure: unknown) {
    throw await rebuildFailure(root, previous, failure);
  }
  // The set-aside root is redundant once every stored project is copied into
  // the private replacement. A root that survives the removal still holds a
  // copy the principals it admits can read, so its path is reported.
  return { preserved, leftover: await removeQuarantinedRoot(previous) };
};

/**
 * Report a repair that could not complete, keeping the stored projects.
 *
 * The set-aside root holds every stored project until the replacement is in
 * place, so it is put back when the repair fails. When it cannot be put
 * back, both directories stay in place and the caller reports their paths.
 */
const rebuildFailure = async (
  root: string,
  previous: string,
  failure: unknown,
): Promise<GhidraProjectCacheError> => {
  const restored = await restoreQuarantinedRoot(previous, root);
  return rootError(
    repairFailureMessage(
      "Ghidra project cache root is not an owner-only directory and could not be rebuilt as a private directory",
      previous,
      restored,
    ),
    root,
    failure,
  );
};

/** Name the set-aside root when the stored projects stay where they were. */
const repairFailureMessage = (
  summary: string,
  previous: string,
  restored: boolean,
): string =>
  restored
    ? summary
    : `${summary}; the previous root is preserved at ${previous}`;

/**
 * Put the set-aside root back when a repair cannot complete.
 *
 * The replacement holds copies of the set-aside root's children, never the
 * only copy of a stored project, so it can be removed without losing one.
 * The set-aside root keeps every stored project until the replacement is in
 * place, so it is put back here. Returns whether the configured path holds
 * the previous root again; when it does not, the caller reports where the
 * stored projects were preserved.
 */
const restoreQuarantinedRoot = async (
  previous: string,
  root: string,
): Promise<boolean> => {
  const removed = await rm(root, { recursive: true, force: true }).then(
    () => true,
    () => false,
  );
  if (!removed) return false;
  try {
    await rename(previous, root);
    return true;
  } catch {
    return false;
  }
};

/**
 * Remove the set-aside root once the private replacement holds every project.
 *
 * Returns the path of a root that survived the removal. It still holds a
 * copy of the stored projects that the principals it admits can read, so the
 * caller reports it instead of leaving it unmentioned.
 */
const removeQuarantinedRoot = async (
  previous: string,
): Promise<string | undefined> => {
  const removed = await rm(previous, { recursive: true, force: true }).then(
    () => true,
    () => false,
  );
  return removed ? undefined : previous;
};

const ensureWindowsRoot = async (
  root: string,
  host: GhidraProjectCacheRootHost,
): Promise<GhidraProjectCacheRootPreparation> => {
  // Only the leaf is private. Its protected, inheritable DACL covers every
  // staging copy, entry, lease, and lock created beneath it.
  await mkdir(dirname(root), { recursive: true });
  const existing = await lstat(root).catch((cause: unknown) => {
    if (isNotFound(cause)) return undefined;
    throw cause;
  });
  if (existing !== undefined) {
    if (!existing.isDirectory() || existing.isSymbolicLink())
      throw rootError(
        "Ghidra project cache root must be a directory, not a link",
        root,
      );
    try {
      host.verifyPrivateDirectory(root);
      return { status: "ready" };
    } catch {
      // POSIX tightens a widened root in place. Windows cannot express an
      // owner-only DACL, so the root is rebuilt as a private directory and the
      // stored projects are copied into it.
      const repair = await replaceWindowsRoot(root, host);
      return {
        status: "repaired",
        preservedEntries: repair.preserved,
        ...(repair.leftover === undefined
          ? {}
          : { leftoverRoot: repair.leftover }),
      };
    }
  }
  try {
    await host.createPrivateDirectory(root);
  } catch (cause: unknown) {
    // A concurrent initializer may have won the name. Accept only a root that
    // then passes the same private-DACL verification.
    const raced = await lstat(root).catch(() => undefined);
    if (raced === undefined)
      throw rootError(
        "Ghidra project cache root could not be created privately",
        root,
        cause,
      );
  }
  await assertDirectory(root);
  try {
    host.verifyPrivateDirectory(root);
  } catch (cause: unknown) {
    throw rootError(
      "Ghidra project cache root could not be verified as owner-only",
      root,
      cause,
    );
  }
  return { status: "ready" };
};

/**
 * Establish the durable cache root before any project bytes are written.
 *
 * POSIX roots are created owner-only and existing widened roots are tightened.
 * Windows roots are created through the native protected-DACL boundary; an
 * existing root that does not pass it is rebuilt as a private directory that
 * keeps the stored projects, because POSIX mode bits do not set a Windows
 * DACL.
 */
export const ensureGhidraProjectCacheRoot = async (
  root: string,
  options: {
    readonly platform?: NodeJS.Platform;
    readonly host?: GhidraProjectCacheRootHost;
  } = {},
): Promise<GhidraProjectCacheRootPreparation> => {
  try {
    if ((options.platform ?? process.platform) === "win32")
      return await ensureWindowsRoot(root, options.host ?? systemRootHost());
    await ensurePosixRoot(root);
    return { status: "ready" };
  } catch (cause: unknown) {
    if (cause instanceof GhidraProjectCacheError) throw cause;
    throw rootError(
      "Ghidra project cache root could not be prepared",
      root,
      cause,
    );
  }
};
