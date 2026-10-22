import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";

import { AnalysisError } from "../domain/analysisErrorBase.js";
import { analysisErrorWithCleanupFailure } from "../domain/analysisErrorCleanup.js";
import {
  AnalysisCancelledError,
  AnalysisResourceConstraintError,
} from "../domain/analysisErrorCore.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { err, ok, type Result } from "../domain/result.js";
import { OwnedFileHandle } from "../filesystem/OwnedFileHandle.js";
import {
  RegularFileCleanupFailure,
  withOwnedFileHandle,
} from "../filesystem/OwnedRegularFile.js";
import { ABORTED, waitForAbortable } from "../process/AbortablePromise.js";
import type { KunaProject } from "./KunaProjectCache.js";
import {
  scanKunaAssembly,
  type KunaAssemblyIndex,
  type KunaProjectFunction,
} from "./KunaProjectFiles.js";
import { KUNA_PROVIDER_ID } from "./KunaRelease.js";
import { KUNA_FUNCTION_TEXT_BYTES } from "./KunaLimits.js";
import { kunaUnavailable } from "./KunaUnavailable.js";

/** The exact producing range for one facet, including a failed C block. */
export interface KunaProjectFileSpan {
  readonly facet: "pseudocode" | "assembly";
  readonly path: string;
  readonly byteOffset: number;
  readonly byteLength: number;
}

export interface KunaProjectText {
  readonly result: string | null;
  readonly files?: readonly KunaProjectFileSpan[];
  readonly limitations: readonly string[];
}

/** Session scope that adopts a span descriptor before the read opens it. */
export interface KunaSpanOwnership {
  readonly retainFailedClose?: (path: string, owner: OwnedFileHandle) => void;
  readonly bindSpanCleanup?: (
    owner: OwnedFileHandle,
    marker: ProviderCleanupError,
  ) => void;
  /**
   * Admit and finalize one span open. The session holds this across the read
   * and its close so a retained descriptor blocks the next open.
   */
  readonly runSpan?: <T>(
    operation: string,
    read: () => Promise<Result<T, AnalysisError>>,
  ) => Promise<Result<T, AnalysisError>>;
}

const readSpan = async (
  operation: string,
  path: string,
  offset: number,
  length: number,
  ownership: KunaSpanOwnership,
): Promise<Result<string, AnalysisError>> => {
  if (length > KUNA_FUNCTION_TEXT_BYTES)
    return err(
      new AnalysisResourceConstraintError(
        operation,
        "capacity",
        "Kuna's function text exceeds the buffered source-facet capacity; the complete export remains accessible locally.",
        {
          limit_bytes: KUNA_FUNCTION_TEXT_BYTES,
          requested_bytes: length,
          file: path,
          byte_offset: offset,
        },
      ),
    );
  const read = async (): Promise<Result<string, AnalysisError>> => {
    const opened = await open(path, "r");
    const owner = new OwnedFileHandle(opened);
    try {
      const text = await withOwnedFileHandle(
        path,
        owner,
        ownership.retainFailedClose === undefined
          ? {}
          : {
              retainFailedClose: (failed) =>
                ownership.retainFailedClose?.(path, failed),
            },
        async (handle) => {
          const buffer = Buffer.alloc(length);
          const { bytesRead } = await handle.read(buffer, 0, length, offset);
          if (bytesRead !== length)
            throw new Error(`${path} is shorter than its recorded span`);
          return buffer.toString("utf8");
        },
      );
      return ok(text);
    } catch (cause: unknown) {
      if (!(cause instanceof RegularFileCleanupFailure)) throw cause;
      return err(
        spanCloseFailure(operation, path, offset, length, cause, ownership),
      );
    }
  };
  return ownership.runSpan === undefined
    ? read()
    : ownership.runSpan(operation, read);
};

/** Keep the span text or the short-read diagnostic with the exact handle. */
const spanCloseFailure = (
  operation: string,
  path: string,
  offset: number,
  length: number,
  failure: RegularFileCleanupFailure<string>,
  ownership: KunaSpanOwnership,
): AnalysisError => {
  const reason =
    failure.cleanupCause instanceof Error
      ? failure.cleanupCause.message
      : String(failure.cleanupCause);
  const completed = failure.outcome.kind === "completed";
  const marker = new ProviderCleanupError(
    KUNA_PROVIDER_ID,
    [failure.path],
    {
      reason,
      path,
      byte_offset: offset,
      byte_length: length,
      span_read: completed ? "completed" : "failed",
      ...(completed ? { span_text: failure.outcome.value } : {}),
    },
    { operation, cause: failure },
  );
  ownership.bindSpanCleanup?.(failure.owner, marker);
  if (failure.outcome.kind !== "failed") return marker;
  const primaryCause = failure.outcome.cause;
  const primary =
    primaryCause instanceof AnalysisError
      ? primaryCause
      : new ProviderAdapterError(KUNA_PROVIDER_ID, operation, {
          cause: primaryCause,
          userMessage:
            primaryCause instanceof Error
              ? primaryCause.message
              : String(primaryCause),
        });
  return analysisErrorWithCleanupFailure(
    primary,
    marker,
    operation,
  ).bindCleanupDependencies([marker]);
};

/** One immutable export owns both its text ranges and its parsed label indexes. */
export class KunaProjectReader {
  #blocks: ReadonlyMap<string, KunaProjectFunction> | undefined;
  #assembly: Promise<Result<KunaAssemblyIndex, string>> | undefined;

  constructor(
    readonly project: KunaProject,
    readonly lifetime: {
      readonly signal: AbortSignal;
      readonly own: <T>(work: Promise<T>) => Promise<T>;
    } & KunaSpanOwnership,
  ) {}

  async pseudocode(
    address: string,
    operation: string,
  ): Promise<Result<KunaProjectText, AnalysisError>> {
    this.#blocks ??= new Map(
      this.project.functions.map((block) => [block.address, block]),
    );
    const block = this.#blocks.get(address);
    if (block === undefined)
      return ok({
        result: null,
        limitations: [
          "Kuna's export decompiles code entries only; this inventory entry, such as an import slot, has no body.",
        ],
      });
    const files = [
      {
        facet: "pseudocode" as const,
        path: this.project.manifest.files.c.path,
        byteOffset: block.cOffset,
        byteLength: block.cLength,
      },
    ];
    if (block.error !== null)
      return ok({
        result: null,
        files,
        limitations: [`Kuna could not decompile this function: ${block.error}`],
      });
    const text = await readSpan(
      operation,
      join(this.project.directory, this.project.manifest.files.c.path),
      block.cOffset,
      block.cLength,
      this.lifetime,
    );
    if (!text.ok) return text;
    return ok({
      result: text.value
        .slice(text.value.indexOf("\n") + 1)
        .replace(/\n+$/u, ""),
      files,
      limitations: [],
    });
  }

  async assembly(
    address: string,
    operation: string,
    signal?: AbortSignal,
  ): Promise<Result<KunaProjectText, AnalysisError>> {
    const index = await this.#index(operation, signal);
    if (!index.ok) return index;
    const span = index.value.code.get(address);
    if (span === undefined)
      return err(
        kunaUnavailable(
          operation,
          `Kuna's export lists no code at ${address}; import slots and data entries have no listing.`,
        ),
      );
    const text = await readSpan(
      operation,
      join(this.project.directory, this.project.manifest.files.asm.path),
      span.offset,
      span.length,
      this.lifetime,
    );
    if (!text.ok) return text;
    return ok({
      result: text.value.replace(/\n+$/u, ""),
      files: [
        {
          facet: "assembly",
          path: this.project.manifest.files.asm.path,
          byteOffset: span.offset,
          byteLength: span.length,
        },
      ],
      limitations: [],
    });
  }

  async dataName(
    address: string,
    operation: string,
    signal?: AbortSignal,
  ): Promise<Result<string | null, AnalysisError>> {
    const index = await this.#index(operation, signal);
    return index.ok ? ok(index.value.data.get(address) ?? null) : index;
  }

  async #index(
    operation: string,
    signal: AbortSignal | undefined,
  ): Promise<Result<KunaAssemblyIndex, AnalysisError>> {
    this.#assembly ??= this.lifetime.own(
      scanKunaAssembly(
        createReadStream(
          join(this.project.directory, this.project.manifest.files.asm.path),
          { signal: this.lifetime.signal },
        ),
      ),
    );
    const index = await waitForAbortable(this.#assembly, signal);
    if (index === ABORTED)
      return err(
        new AnalysisCancelledError(operation, { cause: signal?.reason }),
      );
    return index.ok
      ? index
      : err(
          new ProviderAdapterError(KUNA_PROVIDER_ID, operation, {
            userMessage: `Kuna's .asm cannot be indexed: ${index.error}`,
          }),
        );
  }
}
