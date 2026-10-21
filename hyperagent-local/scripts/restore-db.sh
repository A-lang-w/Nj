#!/usr/bin/env bash
# restore-db.sh — Restore a SQLite database from a backup file.
#
# Usage: ./scripts/restore-db.sh <backup-path>
#
# This script:
#   1. Verifies the backup file exists and passes integrity_check
#   2. Refuses when a live server holds the database (see hyperagent.lock)
#   3. Removes WAL/SHM files to prevent stale state
#   4. Copies the backup into place
#   5. Runs PRAGMA integrity_check on the restored database
#   6. Optionally seeds test queries to verify functionality
#
# Environment:
#   DATA_DIR — directory containing hyperagent.db (default: ./data)
#   SKIP_APP_STOP — set to "true" when the server was already stopped
#     out-of-band (automation/tests); skips the live-holder refusal
#   VERIFY_WITH_QUERY — set to "true" to run a verification query after restore

set -euo pipefail

DATA_DIR="${DATA_DIR:-./data}"
DB_FILE="${DATA_DIR}/hyperagent.db"
LOCK_FILE="${DATA_DIR}/hyperagent.lock"
SKIP_APP_STOP="${SKIP_APP_STOP:-false}"
VERIFY_WITH_QUERY="${VERIFY_WITH_QUERY:-false}"

# --- Argument validation ---
if [ $# -lt 1 ]; then
  echo "[restore-db] ERROR: Missing required argument <backup-path>" >&2
  echo "[restore-db] Usage: $0 <backup-path>" >&2
  exit 1
fi

BACKUP_FILE="$1"

if [ ! -f "$BACKUP_FILE" ]; then
  echo "[restore-db] ERROR: Backup file not found at ${BACKUP_FILE}" >&2
  exit 1
fi

if ! command -v sqlite3 &>/dev/null; then
  echo "[restore-db] ERROR: sqlite3 is required but not found in PATH." >&2
  exit 1
fi

# --- Step 1: Verify backup integrity before overwriting ---
echo "[restore-db] Verifying backup integrity: ${BACKUP_FILE}"
BACKUP_INTEGRITY="$(sqlite3 "$BACKUP_FILE" "PRAGMA integrity_check;" 2>&1)" || true

if [ "$BACKUP_INTEGRITY" != "ok" ]; then
  echo "[restore-db] ERROR: Backup file failed integrity check." >&2
  echo "[restore-db] Result: ${BACKUP_INTEGRITY}" >&2
  exit 1
fi

echo "[restore-db] Backup integrity check passed."

# --- Step 2: Refuse while a live server holds the database ---
# The app records its PID in hyperagent.lock (it never wrote hyperagent.pid,
# so the old PID-file branch always no-op'd and restores overwrote live
# databases). Never auto-kill: PID reuse could murder an unrelated process.
# Refuse instead and let a human stop the server.
if [ "$SKIP_APP_STOP" = "true" ]; then
  echo "[restore-db] Skipping live-holder check (SKIP_APP_STOP=true)."
elif [ -f "$LOCK_FILE" ]; then
  LOCK_PID="$(tr -d '[:space:]' < "$LOCK_FILE" 2>/dev/null || true)"
  # Fail-safe direction mirrors instance-lock.ts: an unparsable lock means
  # we cannot prove no live holder exists, so refuse rather than risk
  # overwriting a running database.
  case "$LOCK_PID" in
    ''|*[!0-9]*)
      echo "[restore-db] ERROR: lock file holds no numeric PID (got '${LOCK_PID}'); refusing to overwrite a possibly live database." >&2
      exit 1
      ;;
  esac
  if [ -n "$LOCK_PID" ]; then
    KILL_PROBE="$(kill -0 "$LOCK_PID" 2>&1 || true)"
    # Empty output: signal delivered, holder is live. "Operation not
    # permitted": a live holder owned by another user (mirrors the
    # fail-safe direction of instance-lock.ts). Anything else (ESRCH /
    # garbage PID): stale, safe to proceed.
    case "$KILL_PROBE" in
      ""|*"Operation not permitted"*)
        echo "[restore-db] ERROR: server appears to be running (PID ${LOCK_PID} from ${LOCK_FILE})." >&2
        echo "[restore-db] Stop the server before restoring; refusing to overwrite a live database." >&2
        exit 1
        ;;
    esac
  fi
  echo "[restore-db] No live server detected; proceeding."
else
  echo "[restore-db] No lock file found; proceeding."
fi

# --- Step 3: Remove WAL and SHM files to prevent stale state ---
WAL_FILE="${DB_FILE}-wal"
SHM_FILE="${DB_FILE}-shm"

if [ -f "$WAL_FILE" ]; then
  echo "[restore-db] Removing stale WAL file: ${WAL_FILE}"
  rm -f "$WAL_FILE"
fi

if [ -f "$SHM_FILE" ]; then
  echo "[restore-db] Removing stale SHM file: ${SHM_FILE}"
  rm -f "$SHM_FILE"
fi

# --- Step 4: Copy backup into place ---
echo "[restore-db] Restoring database from: ${BACKUP_FILE}"
cp "$BACKUP_FILE" "$DB_FILE"

RESTORED_SIZE="$(wc -c < "$DB_FILE" | tr -d ' ')"
echo "[restore-db] Database restored (${RESTORED_SIZE} bytes)"

# --- Step 5: Verify restored database integrity ---
echo "[restore-db] Verifying restored database integrity..."
RESTORED_INTEGRITY="$(sqlite3 "$DB_FILE" "PRAGMA integrity_check;" 2>&1)" || true

if [ "$RESTORED_INTEGRITY" != "ok" ]; then
  echo "[restore-db] ERROR: Restored database failed integrity check." >&2
  echo "[restore-db] Result: ${RESTORED_INTEGRITY}" >&2
  echo "[restore-db] The backup may be corrupt or the copy failed." >&2
  exit 1
fi

echo "[restore-db] Restored database integrity check passed."

# --- Step 6: Optional verification query ---
if [ "$VERIFY_WITH_QUERY" = "true" ]; then
  echo "[restore-db] Running verification query..."
  TABLE_COUNT="$(sqlite3 "$DB_FILE" "SELECT count(*) FROM sqlite_master WHERE type='table';" 2>&1)" || true
  echo "[restore-db] Tables found in restored database: ${TABLE_COUNT}"

  if [ "$TABLE_COUNT" -eq 0 ] 2>/dev/null; then
    echo "[restore-db] WARNING: No tables found in restored database." >&2
  else
    echo "[restore-db] Verification query succeeded."
  fi
fi

echo "[restore-db] Restore completed successfully."