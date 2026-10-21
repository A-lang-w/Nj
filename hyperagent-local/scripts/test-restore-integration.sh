#!/usr/bin/env bash
# test-restore-integration.sh — Integration test for backup and restore.
#
# This test:
# 1. Creates a temporary database with test data
# 2. Backs it up using sqlite3 .backup
# 3. Deletes the test data from the live database
# 4. Restores from backup using restore-db.sh
# 5. Verifies the original data is present
#
# Exit 0 on success, non-zero on failure.

set -euo pipefail

if ! command -v sqlite3 &>/dev/null; then
  echo "[test-restore] ERROR: sqlite3 CLI is required but not found in PATH." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RESTORE_SCRIPT="${SCRIPT_DIR}/restore-db.sh"

# Create isolated temp directory for this test run
TEST_DIR="$(mktemp -d)"
trap 'rm -rf "$TEST_DIR"' EXIT

DATA_DIR="${TEST_DIR}/data"
mkdir -p "$DATA_DIR"

DB_FILE="${DATA_DIR}/hyperagent.db"
BACKUP_FILE="${TEST_DIR}/test-backup.db"

echo "[test-restore] Using test directory: ${TEST_DIR}"

# --- Step 1: Create database with test data ---
echo "[test-restore] Creating test database with sample data..."
sqlite3 "$DB_FILE" <<'SQL'
CREATE TABLE test_records (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  value TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
INSERT INTO test_records (id, name, value) VALUES
  (1, 'alpha', 'first-record'),
  (2, 'beta', 'second-record'),
  (3, 'gamma', 'third-record');
SQL

ORIGINAL_COUNT="$(sqlite3 "$DB_FILE" "SELECT count(*) FROM test_records;")"
ORIGINAL_HASH="$(sqlite3 "$DB_FILE" "SELECT group_concat(name || ':' || value, '|') FROM test_records ORDER BY id;")"

echo "[test-restore] Created ${ORIGINAL_COUNT} records."
echo "[test-restore] Original data fingerprint: ${ORIGINAL_HASH}"

if [ "$ORIGINAL_COUNT" -ne 3 ]; then
  echo "[test-restore] FAIL: Expected 3 records, got ${ORIGINAL_COUNT}" >&2
  exit 1
fi

# --- Step 2: Back up the database ---
echo "[test-restore] Creating backup..."
sqlite3 "$DB_FILE" ".backup '${BACKUP_FILE}'"

if [ ! -f "$BACKUP_FILE" ]; then
  echo "[test-restore] FAIL: Backup file was not created at ${BACKUP_FILE}" >&2
  exit 1
fi

BACKUP_SIZE="$(wc -c < "$BACKUP_FILE" | tr -d ' ')"
echo "[test-restore] Backup created (${BACKUP_SIZE} bytes)."

# --- Step 3: Delete data from live database ---
echo "[test-restore] Deleting all test data from live database..."
sqlite3 "$DB_FILE" "DELETE FROM test_records;"

DELETED_COUNT="$(sqlite3 "$DB_FILE" "SELECT count(*) FROM test_records;")"
echo "[test-restore] Records after deletion: ${DELETED_COUNT}"

if [ "$DELETED_COUNT" -ne 0 ]; then
  echo "[test-restore] FAIL: Expected 0 records after delete, got ${DELETED_COUNT}" >&2
  exit 1
fi

# --- Step 4: Restore from backup ---
echo "[test-restore] Restoring database from backup..."
SKIP_APP_STOP=true DATA_DIR="$DATA_DIR" "$RESTORE_SCRIPT" "$BACKUP_FILE"

# --- Step 5: Verify restored data matches original ---
echo "[test-restore] Verifying restored data..."

RESTORED_COUNT="$(sqlite3 "$DB_FILE" "SELECT count(*) FROM test_records;")"
RESTORED_HASH="$(sqlite3 "$DB_FILE" "SELECT group_concat(name || ':' || value, '|') FROM test_records ORDER BY id;")"

echo "[test-restore] Restored record count: ${RESTORED_COUNT}"
echo "[test-restore] Restored data fingerprint: ${RESTORED_HASH}"

FAILED=0

if [ "$RESTORED_COUNT" -ne "$ORIGINAL_COUNT" ]; then
  echo "[test-restore] FAIL: Record count mismatch. Expected ${ORIGINAL_COUNT}, got ${RESTORED_COUNT}" >&2
  FAILED=1
fi

if [ "$RESTORED_HASH" != "$ORIGINAL_HASH" ]; then
  echo "[test-restore] FAIL: Data fingerprint mismatch." >&2
  echo "[test-restore]   Expected: ${ORIGINAL_HASH}" >&2
  echo "[test-restore]   Got:      ${RESTORED_HASH}" >&2
  FAILED=1
fi

# Verify individual rows
ROW1_VALUE="$(sqlite3 "$DB_FILE" "SELECT value FROM test_records WHERE id=1;")"
ROW2_VALUE="$(sqlite3 "$DB_FILE" "SELECT value FROM test_records WHERE id=2;")"
ROW3_VALUE="$(sqlite3 "$DB_FILE" "SELECT value FROM test_records WHERE id=3;")"

if [ "$ROW1_VALUE" != "first-record" ] || [ "$ROW2_VALUE" != "second-record" ] || [ "$ROW3_VALUE" != "third-record" ]; then
  echo "[test-restore] FAIL: Individual row values do not match expected." >&2
  FAILED=1
fi

if [ "$FAILED" -ne 0 ]; then
  echo "[test-restore] INTEGRATION TEST FAILED" >&2
  exit 1
fi

# --- Step 6: Refuse restore while a live holder exists ---
echo "[test-restore] Verifying live-holder refusal..."
echo "$$" > "${DATA_DIR}/hyperagent.lock"
if DATA_DIR="$DATA_DIR" "$RESTORE_SCRIPT" "$BACKUP_FILE" >/dev/null 2>&1; then
  echo "[test-restore] FAIL: restore proceeded despite a live lock holder." >&2
  exit 1
fi
echo "[test-restore] Live-holder refusal verified."

# --- Step 7: Accept restore with a stale lock ---
echo "[test-restore] Verifying stale-lock acceptance..."
echo "2147483647" > "${DATA_DIR}/hyperagent.lock"
if ! SKIP_APP_STOP="" DATA_DIR="$DATA_DIR" "$RESTORE_SCRIPT" "$BACKUP_FILE" >/dev/null 2>&1; then
  echo "[test-restore] FAIL: restore refused despite a stale lock." >&2
  exit 1
fi
rm -f "${DATA_DIR}/hyperagent.lock"
echo "[test-restore] Stale-lock acceptance verified."

# --- Step 8: Refuse restore with an unparsable lock ---
echo "[test-restore] Verifying garbage-lock refusal..."
echo "not-a-pid" > "${DATA_DIR}/hyperagent.lock"
if DATA_DIR="$DATA_DIR" "$RESTORE_SCRIPT" "$BACKUP_FILE" >/dev/null 2>&1; then
  echo "[test-restore] FAIL: restore proceeded despite an unparsable lock." >&2
  exit 1
fi
rm -f "${DATA_DIR}/hyperagent.lock"
echo "[test-restore] Garbage-lock refusal verified."

echo "[test-restore] INTEGRATION TEST PASSED"
exit 0