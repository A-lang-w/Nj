#!/usr/bin/env bash
# migrate-with-backup.sh — Run Drizzle migrations with automatic backup and rollback safety.
#
# Usage: ./scripts/migrate-with-backup.sh
#
# This script:
#   1. Creates a timestamped backup of the SQLite database
#   2. Records the pre-migration schema version in backup metadata
#   3. Runs drizzle-kit migrate
#   4. Verifies the migration succeeded (database integrity check)
#   5. Retains the backup permanently for rollback via rollback-migration.sh
#
# Backups are never deleted automatically. Use rollback-migration.sh to
# apply down-migrations in reverse order rather than blind file replacement.
#
# Environment:
#   DATA_DIR — directory containing hyperagent.db (default: ./data)

set -euo pipefail

DATA_DIR="${DATA_DIR:-./data}"
DB_FILE="${DATA_DIR}/hyperagent.db"
TIMESTAMP="$(date +%Y%m%d%H%M%S)"
BACKUP_FILE="${DATA_DIR}/hyperagent.db.backup.${TIMESTAMP}"

# --- Pre-flight checks ---
if [ ! -f "$DB_FILE" ]; then
  echo "[migrate-with-backup] ERROR: Database file not found at ${DB_FILE}" >&2
  echo "[migrate-with-backup] Ensure DATA_DIR is set correctly or run db:seed first." >&2
  exit 1
fi

if ! command -v sqlite3 &>/dev/null; then
  # The backup step itself requires the sqlite3 CLI, so a missing binary is
  # fatal — the old "skip integrity and continue" branch died two lines later
  # at the unconditional sqlite3 backup call.
  echo "[migrate-with-backup] ERROR: sqlite3 CLI is required but not found in PATH." >&2
  exit 1
fi

# --- Step 1: Backup ---
echo "[migrate-with-backup] Creating backup: ${BACKUP_FILE}"
sqlite3 "$DB_FILE" ".backup '$BACKUP_FILE'"

if [ ! -f "$BACKUP_FILE" ]; then
  echo "[migrate-with-backup] ERROR: Backup creation failed." >&2
  exit 1
fi

BACKUP_SIZE="$(wc -c < "$BACKUP_FILE" | tr -d ' ')"
echo "[migrate-with-backup] Backup created (${BACKUP_SIZE} bytes)"

# --- Step 1b: Record pre-migration schema version ---
SCHEMA_VERSION="$(sqlite3 "$DB_FILE" "SELECT name FROM __drizzle_migrations ORDER BY created_at DESC LIMIT 1;" 2>/dev/null || echo "none")"
if [ -z "$SCHEMA_VERSION" ]; then
  SCHEMA_VERSION="none"
fi

METADATA_FILE="${BACKUP_FILE}.meta.json"
cat > "$METADATA_FILE" <<EOF
{
  "backup_file": "$(basename "$BACKUP_FILE")",
  "timestamp": "${TIMESTAMP}",
  "schema_version_before": "${SCHEMA_VERSION}",
  "db_size_bytes": ${BACKUP_SIZE}
}
EOF
echo "[migrate-with-backup] Recorded pre-migration schema version: ${SCHEMA_VERSION}"

# --- Step 2: Run migration ---
echo "[migrate-with-backup] Running drizzle-kit migrate..."
MIGRATE_EXIT=0
npx drizzle-kit migrate || MIGRATE_EXIT=$?

if [ "$MIGRATE_EXIT" -ne 0 ]; then
  echo "[migrate-with-backup] ERROR: Migration failed (exit code ${MIGRATE_EXIT})." >&2
  echo "[migrate-with-backup] Backup retained at: ${BACKUP_FILE}" >&2
  echo "[migrate-with-backup] To restore: ./scripts/restore-db.sh '${BACKUP_FILE}'" >&2
  exit "$MIGRATE_EXIT"
fi

# --- Step 3: Verify integrity ---
echo "[migrate-with-backup] Verifying database integrity..."
INTEGRITY_RESULT="$(sqlite3 "$DB_FILE" "PRAGMA integrity_check;" 2>&1)" || true

if [ "$INTEGRITY_RESULT" != "ok" ]; then
  echo "[migrate-with-backup] ERROR: Integrity check failed after migration." >&2
  echo "[migrate-with-backup] Result: ${INTEGRITY_RESULT}" >&2
  echo "[migrate-with-backup] Backup retained at: ${BACKUP_FILE}" >&2
  echo "[migrate-with-backup] To restore: ./scripts/restore-db.sh '${BACKUP_FILE}'" >&2
  exit 1
fi

echo "[migrate-with-backup] Integrity check passed."

# --- Step 4: Retain backup for rollback ---
echo "[migrate-with-backup] Migration succeeded."
echo "[migrate-with-backup] Backup retained at: ${BACKUP_FILE}"
echo "[migrate-with-backup] Metadata at: ${METADATA_FILE}"
echo "[migrate-with-backup] To rollback: ./scripts/rollback-migration.sh '${BACKUP_FILE}'"

echo "[migrate-with-backup] Done."