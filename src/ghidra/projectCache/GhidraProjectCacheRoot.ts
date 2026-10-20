import { chmod, lstat, mkdir, readdir, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

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
  root: string,
  cause?: unknown,
): GhidraProjectCacheError =>
  new GhidraProjectCacheError(
    "io",
    message,
    root,
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
 * Move every child of `from` into `to`.
 *
 * Both directories are on the same volume, so each move is a rename and the
 * stored bytes are preserved exactly. The moved children keep the permissions
 * they were created with; the private root protects everything written into
 * it from then on.
 */
const moveDirectoryContent = async (
  from: string,
  to: string,
): Promise<number> => {
  const names = await readdir(from);
  for (const name of names) {
    await rename(join(from, name), join(to, name));
  }
  return names.length;
};

/**
 * Rebuild a root that native verification refused as a private directory.
 *
 * A root that is not owner-only keeps every stored project readable by the
 * principals its DACL admits, and the store cannot use it at all. The stored
 * children move into a private root that replaces it, so the cache keeps
 * working instead of being disabled for the whole session.
 */
const replaceWindowsRoot = async (
  root: string,
  host: GhidraProjectCacheRootHost,
  cause: unknown,
): Promise<number> => {
  const previous = await quarantineRoot(root);
  let preserved = 0;
  try {
    await host.createPrivateDirectory(root);
    preserved = await moveDirectoryContent(previous, root);
  } catch {
    // The previous root keeps the stored projects when the replacement fails.
    const restored = await restoreQuarantinedRoot(previous, root);
    throw rootError(
      restored
        ? "Ghidra project cache root is not an owner-only directory and could not be rebuilt as a private directory"
        : `Ghidra project cache root is not an owner-only directory and could not be rebuilt as a private directory; the previous root is preserved at ${previous}`,
      root,
      cause,
    );
  }
  // The set-aside root is emptied only after the replacement is in place.
  await rm(previous, { recursive: true, force: true }).catch(() => undefined);
  await assertDirectory(root);
  try {
    host.verifyPrivateDirectory(root);
  } catch (verification: unknown) {
    throw rootError(
      "Ghidra project cache root could not be verified as owner-only",
      root,
      verification,
    );
  }
  return preserved;
};

/**
 * Put the set-aside root back when a repair cannot complete.
 *
 * Returns whether the configured path holds the previous root again. When it
 * does not, the caller reports where the stored projects were preserved.
 */
const restoreQuarantinedRoot = async (
  previous: string,
  root: string,
): Promise<boolean> => {
  // Return the children that already moved into the replacement, so the
  // previous root keeps every stored project.
  await moveDirectoryContent(root, previous).catch(() => undefined);
  await rm(root, { recursive: true, force: true }).catch(() => undefined);
  try {
    await rename(previous, root);
    return true;
  } catch {
    return false;
  }
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
    } catch (cause: unknown) {
      // POSIX tightens a widened root in place. Windows cannot express an
      // owner-only DACL, so the root is rebuilt as a private directory and the
      // stored projects move into it.
      const preserved = await replaceWindowsRoot(root, host, cause);
      return { status: "repaired", preservedEntries: preserved };
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
