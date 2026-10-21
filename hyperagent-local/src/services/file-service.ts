import { eq, desc, and } from "drizzle-orm";
import { db } from "../db/connection.js";
import { files } from "../db/schema.js";
import { emitEvent } from "../domain/events.js";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { mkdir, unlink, stat, rename, statfs } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable, Transform } from "node:stream";
import { DEFAULT_PAGE_LIMIT } from "../config/constants.js";
import { config } from "../config.js";
import {
  Ok,
  Err,
  ValidationError,
  CapacityError,
  StorageError,
} from "../lib/result.js";
import type { Result } from "../lib/result.js";

export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024; // 100 MB default limit

type UploadBody = ReadableStream<Uint8Array> | Buffer;

/**
 * Sanitizes the uploader-supplied filename and resolves the final storage
 * path, rejecting names that escape the workspace storage directory.
 */
function resolveStoragePath(
  storageDir: string,
  filename: string,
): Result<{ storagePath: string; tmpPath: string }, ValidationError> {
  // Preserve valid Unicode characters; strip only path separators, null bytes, and control characters.
  // oxlint-disable-next-line no-control-regex -- stripping C0 controls from filenames is intentional.
  const safeName = path.basename(filename).replace(/[/\\:\x00-\x1f]/g, "_");
  if (!safeName || safeName === "." || safeName === "..") {
    return Err(
      new ValidationError("Invalid filename: rejected after sanitization"),
    );
  }
  // Date.now() alone is not unique: two same-name uploads landing in the
  // same millisecond would share a storage path and the second rename
  // would silently overwrite the first file's bytes. A random suffix
  // makes collisions computationally impossible.
  const storageName = `${Date.now()}-${randomBytes(8).toString("hex")}-${safeName}`;
  const storagePath = path.resolve(storageDir, storageName);
  if (!storagePath.startsWith(path.resolve(storageDir) + path.sep)) {
    return Err(
      new ValidationError("Invalid storage path: escapes storage directory"),
    );
  }
  return Ok({ storagePath, tmpPath: `${storagePath}.tmp` });
}

/**
 * Pre-flight disk-space check for a declared upload size. A statfs failure
 * is non-fatal: the write proceeds and fails naturally if space is exhausted.
 */
async function assertDiskSpace(
  storageDir: string,
  declaredSize: number | undefined,
): Promise<Result<void, CapacityError>> {
  if (declaredSize === undefined) {
    return Ok(undefined);
  }
  try {
    const fsStats = await statfs(storageDir);
    const availableBytes = fsStats.bavail * fsStats.bsize;
    if (availableBytes < declaredSize) {
      return Err(
        new CapacityError(
          `Insufficient disk space: need ${declaredSize} bytes but only ${availableBytes} available`,
        ),
      );
    }
  } catch {
    // statfs failure is non-fatal; proceed with write and let it fail naturally if space is exhausted.
  }
  return Ok(undefined);
}

/**
 * Streams the upload body to a temp path with byte counting, then verifies
 * the temp file size matches. Cleans up the temp file on any failure.
 *
 * @returns The verified byte count, or CapacityError/StorageError on failure.
 */
async function writeVerifiedTemp(
  body: UploadBody,
  tmpPath: string,
): Promise<Result<number, CapacityError | StorageError>> {
  // Accept both Web ReadableStream and Node Buffer for test compatibility
  const nodeStream = Buffer.isBuffer(body)
    ? Readable.from(body)
    : Readable.fromWeb(body as import("node:stream/web").ReadableStream);
  let bytesWritten = 0;
  const countingTransform = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytesWritten += chunk.length;
      if (bytesWritten > MAX_UPLOAD_BYTES) {
        callback(
          new Error(
            `File exceeds maximum allowed size of ${MAX_UPLOAD_BYTES} bytes`,
          ),
        );
      } else {
        callback(null, chunk);
      }
    },
  });

  try {
    await pipeline(nodeStream, countingTransform, createWriteStream(tmpPath));
  } catch (err) {
    try {
      await unlink(tmpPath);
    } catch {
      /* best-effort cleanup */
    }
    if (
      err instanceof Error &&
      err.message.includes("exceeds maximum allowed size")
    ) {
      return Err(new CapacityError(err.message));
    }
    return Err(
      new StorageError(
        err instanceof Error ? err.message : "Unknown storage write failure",
      ),
    );
  }

  try {
    const tmpStat = await stat(tmpPath);
    if (tmpStat.size !== bytesWritten) {
      await unlink(tmpPath);
      return Err(
        new StorageError(
          `Write verification failed: expected ${bytesWritten} bytes but temp file is ${tmpStat.size} bytes`,
        ),
      );
    }
  } catch (err) {
    try {
      await unlink(tmpPath);
    } catch {
      /* best-effort cleanup */
    }
    return Err(
      new StorageError(
        err instanceof Error ? err.message : "Failed to verify temp file",
      ),
    );
  }

  return Ok(bytesWritten);
}

interface RecordFileInput {
  workspaceId: number;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  storagePath: string;
  uploadedBy: number;
  threadId?: number | null;
}

/**
 * Records an already-persisted file in the database. Does not touch the
 * filesystem; the caller removes the stored bytes when this fails.
 */
async function recordFile(
  input: RecordFileInput,
): Promise<Result<typeof files.$inferSelect, StorageError>> {
  try {
    const [file] = await db
      .insert(files)
      .values({
        workspaceId: input.workspaceId,
        threadId: input.threadId ?? null,
        filename: input.filename,
        mimeType: input.mimeType,
        sizeBytes: input.sizeBytes,
        storagePath: input.storagePath,
        uploadedBy: input.uploadedBy,
      })
      .returning();
    // The global bus forwards to every connected socket: emit ids only,
    // never user-authored text such as filenames.
    emitEvent("file.uploaded", { id: file.id, workspaceId: input.workspaceId });
    return Ok(file);
  } catch (err) {
    return Err(
      new StorageError(
        err instanceof Error ? err.message : "Database insert failed",
      ),
    );
  }
}

/**
 * Persist an uploaded file to disk and record it in the database.
 *
 * The file is first written to a temporary path, verified, then atomically
 * renamed to its final storage location. If any step fails, the temporary or
 * final file is removed so no orphaned bytes remain on disk. A database insert
 * failure also triggers cleanup of the persisted file.
 *
 * Emits `file.uploaded` with `{ id, workspaceId }` on success.
 *
 * @param workspaceId - Owner workspace for the file.
 * @param filename - Original filename supplied by the uploader; sanitized before use.
 * @param mimeType - MIME type recorded in the database.
 * @param body - File content as a Web ReadableStream or Node Buffer.
 * @param uploadedBy - User ID attributed as the uploader.
 * @param threadId - Optional thread association; stored as `null` when omitted.
 * @param declaredSize - Optional pre-flight size in bytes used for capacity checks.
 * @returns `Ok(file)` on success, or one of:
 *   - `ValidationError` when the sanitized filename is empty or the resolved path escapes the storage directory.
 *   - `CapacityError` when `declaredSize` exceeds the upload limit or available disk space.
 *   - `StorageError` when writing, verifying, renaming, or recording the file fails.
 */
export async function saveFile(
  workspaceId: number,
  filename: string,
  mimeType: string,
  body: UploadBody,
  uploadedBy: number,
  threadId?: number | null,
  declaredSize?: number,
): Promise<
  Result<
    typeof files.$inferSelect,
    ValidationError | CapacityError | StorageError
  >
> {
  if (declaredSize !== undefined && declaredSize > MAX_UPLOAD_BYTES) {
    return Err(
      new CapacityError(
        `File exceeds maximum allowed size of ${MAX_UPLOAD_BYTES} bytes`,
      ),
    );
  }

  const storageDir = path.join(config.dataDir, "files", String(workspaceId));
  await mkdir(storageDir, { recursive: true });

  const resolved = resolveStoragePath(storageDir, filename);
  if (!resolved.ok) return resolved;
  const { storagePath, tmpPath } = resolved.value;

  // Check available disk space before writing when a declared size is known.
  const space = await assertDiskSpace(storageDir, declaredSize);
  if (!space.ok) return space;

  const written = await writeVerifiedTemp(body, tmpPath);
  if (!written.ok) return written;

  // Atomically rename temp file to final path.
  try {
    await rename(tmpPath, storagePath);
  } catch (err) {
    try {
      await unlink(tmpPath);
    } catch {
      /* best-effort cleanup */
    }
    return Err(
      new StorageError(
        err instanceof Error
          ? err.message
          : "Atomic rename to final path failed",
      ),
    );
  }

  const recorded = await recordFile({
    workspaceId,
    filename,
    mimeType,
    sizeBytes: written.value,
    storagePath,
    uploadedBy,
    threadId,
  });
  if (!recorded.ok) {
    // Clean up the persisted file if the database insert fails to avoid orphaned files.
    try {
      await unlink(storagePath);
    } catch {
      /* best-effort cleanup */
    }
    return recorded;
  }
  return recorded;
}

/**
 * List files stored for a workspace, optionally filtered by thread.
 *
 * Results are ordered by creation time descending. No events are emitted and
 * no cleanup is performed; this is a read-only query.
 *
 * @param workspaceId - Workspace whose files should be returned.
 * @param threadId - When provided and non-null, restrict results to this thread.
 * @param limit - Maximum number of rows to return (default 50).
 * @param offset - Number of rows to skip for pagination (default 0).
 * @returns A promise resolving to an array of file records matching the filters.
 */
export async function getFiles(
  workspaceId: number,
  threadId?: number | null,
  limit = DEFAULT_PAGE_LIMIT,
  offset = 0,
) {
  const conditions = [eq(files.workspaceId, workspaceId)];
  if (threadId !== undefined && threadId !== null) {
    conditions.push(eq(files.threadId, threadId));
  }
  return db
    .select()
    .from(files)
    .where(and(...conditions))
    .orderBy(desc(files.createdAt))
    .limit(limit)
    .offset(offset);
}

/**
 * Remove a file record and its backing storage.
 *
 * The on-disk file is unlinked before the database row is deleted. If the file
 * is already missing or inaccessible, the database delete still proceeds so
 * stale records can be cleaned up. Emits `file.deleted` with `{ id }` after
 * the database row is removed, regardless of whether the physical file existed.
 *
 * @param fileId - Primary key of the file record to delete.
 * @param workspaceId - Authorized workspace that must own the file (defense in depth).
 * @returns A promise that resolves when both storage and database cleanup have completed.
 */
export async function deleteFile(fileId: number, workspaceId: number) {
  const [file] = await db
    .select()
    .from(files)
    .where(and(eq(files.id, fileId), eq(files.workspaceId, workspaceId)));
  // Deleting a missing row is a successful no-op, but subscribers must not
  // receive a phantom deletion event for a record that never existed.
  if (!file) return;
  try {
    await stat(file.storagePath);
    await unlink(file.storagePath);
  } catch {
    // File already removed or inaccessible; proceed with DB cleanup.
  }
  await db
    .delete(files)
    .where(and(eq(files.id, fileId), eq(files.workspaceId, workspaceId)));
  emitEvent("file.deleted", { id: fileId, workspaceId: file.workspaceId });
}
