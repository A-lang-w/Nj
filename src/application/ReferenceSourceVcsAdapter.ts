import fs from "node:fs";
import { lstat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { err, ok, type Result } from "../domain/result.js";
import type { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import {
  readRegularFile,
  RegularFileCleanupFailure,
  retryRegularFileCleanup,
} from "./RegularFileRead.js";
import type { ReferenceSourceReaderError } from "../reference/ReferenceSourceReaderTypes.js";

export type ReferenceSourceVcsInfo =
  | {
      readonly kind: "git";
      readonly head: string;
      readonly dirty: boolean | null;
    }
  | { readonly kind: "none"; readonly head: null; readonly dirty: null }
  | { readonly kind: "unknown"; readonly head: null; readonly dirty: null };

export interface ReferenceSourceVcsObservation {
  readonly info: ReferenceSourceVcsInfo;
  /** `null` means a repository was found but its local setting was unreadable or invalid. */
  readonly ignoreCase: boolean | null;
}

/**
 * Read Git metadata for a directory using isomorphic-git.
 *
 * No git subprocess or network is used; only the local `.git` object store is read.
 */
export const readReferenceSourceVcs = async (
  root: string,
  resources: ArtifactResourceScope,
  signal?: AbortSignal,
): Promise<
  Result<ReferenceSourceVcsObservation, ReferenceSourceReaderError>
> => {
  try {
    return await resources.run(async () => {
      // Like Git, a subdirectory belongs to its nearest enclosing repository;
      // only a missing `.git` at every ancestor means no version control.
      let repository = resolve(root);
      for (;;) {
        if (isAborted(signal))
          return ok({ info: unknownVcs(), ignoreCase: null });
        try {
          await lstat(join(repository, ".git"));
          break;
        } catch (cause: unknown) {
          if (errorCode(cause) !== "ENOENT")
            return ok({ info: unknownVcs(), ignoreCase: null });
        }
        const parent = dirname(repository);
        if (parent === repository)
          return ok({
            info: { kind: "none", head: null, dirty: null },
            ignoreCase: false,
          });
        repository = parent;
      }
      let ignoreCase: boolean | null = null;
      try {
        ignoreCase = await readIgnoreCase(repository, signal);
        const head = await resolveSourceHead(repository, resources, signal);
        if (isAborted(signal))
          return ok({ info: unknownVcs(), ignoreCase: null });
        return ok({ info: { kind: "git", head, dirty: null }, ignoreCase });
      } catch (cause: unknown) {
        if (cause instanceof ArtifactReaderFailure) throw cause;
        return ok({ info: unknownVcs(), ignoreCase });
      }
    });
  } catch (cause: unknown) {
    if (!(cause instanceof ArtifactReaderFailure)) throw cause;
    return err({
      tag: "reference-source-reader",
      code: cause.reason === "cancelled" ? "cancelled" : "io",
      message: cause.message,
      ...(cause.cleanup === undefined ? {} : { cleanup: cause.cleanup }),
      cause,
    });
  }
};

const unknownVcs = (): ReferenceSourceVcsInfo => ({
  kind: "unknown",
  head: null,
  dirty: null,
});

const readIgnoreCase = async (
  repository: string,
  signal?: AbortSignal,
): Promise<boolean | null> => {
  try {
    signal?.throwIfAborted();
    const { getConfig, getConfigAll } = await import("isomorphic-git");
    const value = await getConfig({
      fs,
      dir: repository,
      path: "core.ignoreCase",
    });
    // The pinned library reads only local config and does not evaluate
    // include/includeIf. A local include can override this value, while a
    // missing local value leaves system/global config in play.
    const [includes, conditionalIncludes] = await Promise.all([
      getConfigAll({ fs, dir: repository, path: "include.path" }),
      getConfigAll({ fs, dir: repository, path: "includeIf.path" }),
    ]);
    signal?.throwIfAborted();
    if (
      value === undefined ||
      includes.length > 0 ||
      conditionalIncludes.length > 0
    )
      return null;
    if (value === true || value === false) return value;
    if (typeof value === "string") {
      if (/^(?:true|yes|on|1)$/iu.test(value)) return true;
      if (/^(?:false|no|off|0)$/iu.test(value)) return false;
    }
    return null;
  } catch {
    return null;
  }
};

const resolveSourceHead = async (
  root: string,
  resources: ArtifactResourceScope,
  signal?: AbortSignal,
): Promise<string> => {
  // isomorphic-git is loaded on first use so CLI and MCP startup skip it.
  const { resolveRef } = await import("isomorphic-git");
  let failedRead: { readonly cause: unknown } | undefined;
  const cleanupFailures: ArtifactReaderFailure[] = [];
  const readMetadataBytes = async (path: string): Promise<Buffer> => {
    try {
      return await readRegularFile(path, { signal });
    } catch (cause: unknown) {
      if (signal?.aborted === true && cause === signal.reason) throw cause;
      if (!(cause instanceof RegularFileCleanupFailure)) throw cause;
      const retry = await retryRegularFileCleanup(cause, resources, signal);
      if (
        retry.outcome.kind === "failed" &&
        errorCode(retry.outcome.cause) !== "ENOENT"
      )
        failedRead ??= { cause: retry.outcome.cause };
      if (
        retry.cleanup === undefined &&
        retry.outcome.kind === "failed" &&
        !isAborted(signal)
      )
        throw retry.outcome.cause;
      const primary =
        retry.outcome.kind === "failed"
          ? retry.outcome.cause
          : cause.cleanupCause;
      throw new ArtifactReaderFailure(
        isAborted(signal) ? "cancelled" : "io",
        `Git metadata could not be read safely: ${errorMessage(primary)}`,
        {
          cause: primary,
          ...(retry.cleanup === undefined ? {} : { cleanup: retry.cleanup }),
        },
      );
    }
  };
  const readMetadataText = async (path: string): Promise<string> =>
    (await readMetadataBytes(path)).toString("utf8");
  const throwCleanupFailures = (primary: unknown): never => {
    const observations = cleanupFailures.flatMap((failure) =>
      failure.cleanup === undefined ? [] : [failure.cleanup],
    );
    throw new ArtifactReaderFailure(
      isAborted(signal) ? "cancelled" : "io",
      `Git metadata could not be read safely: ${errorMessage(primary)}`,
      {
        cause: new AggregateError(
          [primary, ...cleanupFailures],
          "Git metadata reads and cleanup failed",
          { cause: primary },
        ),
        ...(observations.length === 0
          ? {}
          : {
              cleanup: {
                reason: observations.map(({ reason }) => reason).join("; "),
                resources: [
                  ...new Set(
                    observations.flatMap(({ resources }) => resources),
                  ),
                ],
              },
            }),
      },
    );
  };
  const referenceFs = {
    ...fs,
    promises: {
      ...fs.promises,
      // Let isomorphic-git continue from a failed loose ref to packed-refs,
      // then report the original read failure after resolution. This preserves
      // both observations when packed metadata also fails cleanup.
      readFile: async (
        path: string | undefined,
        options:
          | BufferEncoding
          | { readonly encoding?: BufferEncoding | null }
          | null = null,
      ) => {
        // The library probes readFile() without a path to detect promise APIs.
        // Reject that invocation without attributing it to a source read.
        if (path === undefined)
          throw new TypeError("Git metadata path is required");
        try {
          const bytes = await readMetadataBytes(path);
          const encoding =
            typeof options === "string"
              ? options
              : typeof options === "object" &&
                  options !== null &&
                  "encoding" in options
                ? options.encoding
                : undefined;
          if (encoding === undefined || encoding === null) return bytes;
          if (typeof encoding !== "string" || !Buffer.isEncoding(encoding))
            throw new TypeError("Unsupported Git metadata text encoding");
          return bytes.toString(encoding);
        } catch (cause: unknown) {
          if (cause instanceof ArtifactReaderFailure) {
            cleanupFailures.push(cause);
          } else if (errorCode(cause) !== "ENOENT") failedRead ??= { cause };
          throw cause;
        }
      },
    },
  };
  const readRef = async (options: {
    readonly gitdir?: string;
    readonly ref: string;
  }) => {
    let head: string;
    try {
      head = await resolveRef({ fs: referenceFs, dir: root, ...options });
    } catch (cause: unknown) {
      if (cleanupFailures.length > 0)
        throwCleanupFailures(failedRead?.cause ?? cause);
      if (failedRead !== undefined) throw failedRead.cause;
      throw cause;
    }
    if (cleanupFailures.length > 0)
      throwCleanupFailures(failedRead?.cause ?? cleanupFailures[0]?.cause);
    signal?.throwIfAborted();
    if (failedRead !== undefined) throw failedRead.cause;
    return head;
  };
  const dotgit = join(root, ".git");
  if (!(await lstat(dotgit)).isFile()) return readRef({ ref: "HEAD" });
  const pointer = (await readMetadataText(dotgit)).replace(/\r?\n$/u, "");
  if (!pointer.startsWith("gitdir: ") || pointer.length === 8)
    throw new Error("Invalid Git directory pointer");
  const gitdir = resolve(root, pointer.slice(8));
  let commonDirectory: string;
  try {
    commonDirectory = resolve(
      gitdir,
      (await readMetadataText(join(gitdir, "commondir"))).replace(
        /\r?\n$/u,
        "",
      ),
    );
  } catch (cause: unknown) {
    if (errorCode(cause) !== "ENOENT") throw cause;
    return readRef({ gitdir, ref: "HEAD" });
  }
  const head = (await readMetadataText(join(gitdir, "HEAD"))).trim();
  if (!head.startsWith("ref: ")) return readRef({ gitdir, ref: "HEAD" });
  const ref = head.slice(5);
  const privateRef = ["refs/bisect/", "refs/rewritten/", "refs/worktree/"].some(
    (prefix) => ref.startsWith(prefix),
  );
  return readRef({
    gitdir: privateRef ? gitdir : commonDirectory,
    ref,
  });
};

const errorCode = (cause: unknown): string | undefined =>
  typeof cause === "object" && cause !== null && "code" in cause
    ? String(cause.code)
    : undefined;

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const isAborted = (signal?: AbortSignal): boolean => signal?.aborted === true;
