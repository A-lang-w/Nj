import fsSync from "node:fs";

// --- Single-Instance Lock (WAL write serialization) ---
// WAL mode does not serialize writes across separate processes; only one
// process may hold the database open for writing at a time. The lock file
// stores the holder's PID so stale locks can be diagnosed and reclaimed.

export function createLockFile(lockFilePath: string): void {
  // O_EXCL ensures we fail if another instance already created the lock file.
  // We also write our PID so stale locks can be diagnosed and reclaimed.
  const fd = fsSync.openSync(
    lockFilePath,
    fsSync.constants.O_CREAT |
      fsSync.constants.O_EXCL |
      fsSync.constants.O_WRONLY,
    0o644,
  );
  fsSync.writeSync(fd, String(process.pid));
  fsSync.closeSync(fd);
  // File is now held by path existence; cleanup via unlink on exit.
}

/** True when no live process owns the lock (crash/SIGKILL leftover). */
export function isLockStale(lockFilePath: string): boolean {
  let recordedPid: number | null = null;
  try {
    recordedPid = parseInt(
      fsSync.readFileSync(lockFilePath, "utf-8").trim(),
      10,
    );
  } catch {
    return false;
  }
  if (!Number.isInteger(recordedPid)) return false;
  // A lock recording our own PID cannot be owned by a live holder: this
  // process has not created it yet. Without this, a SIGKILLed container
  // (PID 1) can never restart — the new PID 1 always "owns" the old lock.
  if (recordedPid === process.pid) return true;
  try {
    process.kill(recordedPid, 0);
    return false; // A live process holds the lock.
  } catch (err) {
    // ESRCH: no such process — the holder died without cleanup. Any other
    // error (e.g. EPERM: a live process we may not signal) keeps the lock.
    // Residual risk: PID reuse could mistake a new process for the holder;
    // the failure direction is fail-safe (refuse to start, never corrupt).
    return (err as NodeJS.ErrnoException).code === "ESRCH";
  }
}

/**
 * Claims a stale lock for this process. Returns true when this process now
 * holds a fresh lock file, false when another instance (live or racing)
 * owns the path and this process must exit instead.
 *
 * The rename is the atomic arbiter between racing reclaimers: exactly one
 * `renameSync` of the same path wins; losers see ENOENT and refuse. An
 * unlink-then-create sequence cannot arbitrate — the second unlink would
 * delete the first winner's fresh lock and admit two writers.
 *
 * Residual: if a live starter creates a lock between our stale check and
 * the rename, we steal a live lock aside and must restore it; a third
 * starter creating in that microsecond restore gap runs lockless. That
 * needs three starters inside one rename window — negligible for a local
 * tool — while every two-party race below is closed by construction.
 */
export function claimStaleLock(lockFilePath: string): boolean {
  if (!isLockStale(lockFilePath)) return false;
  const asidePath = `${lockFilePath}.reclaim.${process.pid}`;
  try {
    fsSync.renameSync(lockFilePath, asidePath);
  } catch {
    // Lost the race (path already renamed or removed): do not start.
    return false;
  }
  try {
    // Re-verify AFTER winning: the file we moved aside may hold a fresh
    // PID when a live starter created it between our check and the rename.
    if (!isLockStale(asidePath)) {
      try {
        if (!fsSync.existsSync(lockFilePath)) {
          fsSync.renameSync(asidePath, lockFilePath);
        } else {
          // Another starter already claimed the gap; its live lock stands.
          fsSync.unlinkSync(asidePath);
        }
      } catch {
        // Best effort; we refuse to start regardless.
      }
      return false;
    }
    fsSync.unlinkSync(asidePath);
  } catch {
    return false;
  }
  try {
    createLockFile(lockFilePath);
    return true;
  } catch {
    // EEXIST: another starter claimed the path after our rename.
    return false;
  }
}

export function releaseLockFile(lockFilePath: string): void {
  try {
    // Only release a lock we own: if the file was removed and recreated by
    // another instance between our startup and exit, an unconditional unlink
    // would steal that instance's lock and admit a second writer.
    const recordedPid = parseInt(
      fsSync.readFileSync(lockFilePath, "utf-8").trim(),
      10,
    );
    if (recordedPid !== process.pid) return;
    fsSync.unlinkSync(lockFilePath);
  } catch {
    // Lock file may already be removed; nothing to do.
  }
}
