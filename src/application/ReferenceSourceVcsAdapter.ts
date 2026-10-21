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
        ignoreCase = await readIgnoreCase(repository, resources, signal);
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
  resources: ArtifactResourceScope,
  signal?: AbortSignal,
): Promise<boolean | null> => {
  try {
    const configPath = await gitConfigPath(repository, resources, signal);
    if (configPath === undefined) return null;
    const configText = await readOwnedMetadataText(
      configPath,
      resources,
      signal,
    );
    return parseEffectiveIgnoreCase(configText);
  } catch (cause: unknown) {
    if (cause instanceof ArtifactReaderFailure) throw cause;
    return null;
  }
};

/** Resolve the effective local config file for both ordinary and linked worktrees. */
const gitConfigPath = async (
  root: string,
  resources: ArtifactResourceScope,
  signal?: AbortSignal,
): Promise<string | undefined> => {
  const dotgit = join(root, ".git");
  let gitdir = dotgit;
  const metadata = await lstat(dotgit);
  if (!metadata.isDirectory()) {
    const pointer = (
      await readOwnedMetadataText(dotgit, resources, signal)
    ).trim();
    const match = /^gitdir:\s*(.+)$/iu.exec(pointer);
    if (match?.[1] === undefined) return undefined;
    gitdir = resolve(root, match[1]);
  }
  try {
    const common = (
      await readOwnedMetadataText(join(gitdir, "commondir"), resources, signal)
    ).trim();
    gitdir = resolve(gitdir, common);
  } catch (cause: unknown) {
    if (errorCode(cause) !== "ENOENT") throw cause;
  }
  return join(gitdir, "config");
};

/** Read Git's section/subsection syntax without flattening includeIf identities. */
const parseEffectiveIgnoreCase = (text: string): boolean | null => {
  let section: string | undefined;
  let subsection: string | undefined;
  const values: string[] = [];
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
    const header =
      /^\[\s*([A-Za-z][A-Za-z0-9-]*)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\](?:\s*[#;].*)?$/u.exec(
        line,
      );
    if (header !== null) {
      section = header[1]?.toLowerCase();
      subsection = header[2]?.replace(/\\([\\"])/gu, "$1");
      if (section === "include" || section === "includeif") return null;
      continue;
    }
    if (section === undefined) return null;
    const variable = /^([A-Za-z][A-Za-z0-9-]*)\s*(?:=\s*(.*))?$/u.exec(line);
    if (variable === null) return null;
    const name = variable[1]?.toLowerCase();
    const sourceValue = variable[2];
    if (section !== "core" || subsection !== undefined || name !== "ignorecase")
      continue;
    if (sourceValue === undefined) {
      values.push("true");
      continue;
    }
    const parsedValue = parseGitConfigValue(sourceValue);
    if (parsedValue === undefined) return null;
    values.push(parsedValue);
  }
  const value = values.at(-1)?.toLowerCase();
  if (value === "true" || value === "yes" || value === "on" || value === "1")
    return true;
  if (value === "false" || value === "no" || value === "off" || value === "0")
    return false;
  return null;
};

const parseGitConfigValue = (source: string): string | undefined => {
  let value = "";
  let quoted = false;
  let escaped = false;
  for (const character of source.trim()) {
    if (escaped) {
      if (character !== "\\" && character !== '"') return undefined;
      value += character;
      escaped = false;
    } else if (character === "\\" && quoted) {
      escaped = true;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (!quoted && (character === "#" || character === ";")) {
      break;
    } else {
      value += character;
    }
  }
  return quoted || escaped ? undefined : value.trim();
};

const readOwnedMetadataText = async (
  path: string,
  resources: ArtifactResourceScope,
  signal?: AbortSignal,
): Promise<string> =>
  (await readOwnedMetadataBytes(path, resources, signal)).toString("utf8");

const readOwnedMetadataBytes = async (
  path: string,
  resources: ArtifactResourceScope,
  signal?: AbortSignal,
): Promise<Buffer> => {
  try {
    return await readRegularFile(path, { signal });
  } catch (cause: unknown) {
    if (signal?.aborted === true && cause === signal.reason)
      throw new ArtifactReaderFailure(
        "cancelled",
        "Git metadata read cancelled",
        {
          cause,
          cancellation: { reason: signal.reason },
        },
      );
    if (!(cause instanceof RegularFileCleanupFailure)) {
      if (isAborted(signal))
        throw new ArtifactReaderFailure(
          "cancelled",
          "Git metadata read cancelled",
          {
            cause: signal?.reason,
            cancellation: { reason: signal?.reason },
          },
        );
      throw cause;
    }
    const retry = await retryRegularFileCleanup(cause, resources, signal);
    if (retry.cleanup !== undefined || retry.outcome.kind === "failed") {
      const primary =
        retry.outcome.kind === "failed"
          ? retry.outcome.cause
          : cause.cleanupCause;
      throw new ArtifactReaderFailure(
        isAborted(signal) ? "cancelled" : "io",
        `Git metadata could not be read safely: ${errorMessage(primary)}`,
        {
          cause: primary,
          ...(isAborted(signal)
            ? { cancellation: { reason: signal?.reason } }
            : {}),
          ...(retry.cleanup === undefined ? {} : { cleanup: retry.cleanup }),
        },
      );
    }
    if (isAborted(signal))
      throw new ArtifactReaderFailure(
        "cancelled",
        "Git metadata read cancelled",
        {
          cause: signal?.reason,
          cancellation: { reason: signal?.reason },
        },
      );
    return retry.outcome.value;
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
      return await readOwnedMetadataBytes(path, resources, signal);
    } catch (cause: unknown) {
      if (cause instanceof ArtifactReaderFailure) {
        if (cause.reason !== "cancelled" && errorCode(cause.cause) !== "ENOENT")
          failedRead ??= { cause: cause.cause };
        throw cause;
      }
      throw cause;
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
