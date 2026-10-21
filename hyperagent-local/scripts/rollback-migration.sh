#!/usr/bin/env bash
# rollback-migration.sh — Roll back migrations using down-migration SQL files
# when they exist, else delegate to a safe file-level restore.
#
# Usage: ./scripts/rollback-migration.sh <backup-file> [target-version]
#
# Arguments:
#   backup-file    — Path to the .db.backup.* file created by migrate-with-backup.sh
#   target-version — Optional migration name to roll back to (default: pre-backup version from metadata)
#
# This script:
# 1. Reads the pre-migration schema version from backup metadata
# 2. Validates the backup file exists and metadata is consistent
# 3. Identifies down-migration SQL files to apply in reverse order
# 4. Applies each down-migration within a transaction, or — when no down
#    migrations are shipped — delegates to restore-db.sh (live-safe,
#    integrity-checked) instead of erroring out or raw-copying
# 5. Verifies database integrity after rollback
#
# Down-migration files must exist at drizzle/down/<migration-name>.sql
# Generate them with: npx drizzle-kit generate --down
#
# Environment:
#   DATA_DIR — directory containing hyperagent.db (default: ./data)

set -euo pipefail

DATA_DIR="${DATA_DIR:-./data}"
DB_FILE="${DATA_DIR}/hyperagent.db"
DRIZZLE_DOWN_DIR="drizzle/down"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

if [ $# -lt 1 ]; then
  echo "[rollback-migration] Usage: $0 <backup-file> [target-version]" >&2
  exit 1
fi

BACKUP_FILE="$1"
TARGET_VERSION="${2:-}"

# --- Validate inputs ---
if [ ! -f "$BACKUP_FILE" ]; then
  echo "[rollback-migration] ERROR: Backup file not found: ${BACKUP_FILE}" >&2
  exit 1
fi

METADATA_FILE="${BACKUP_FILE}.meta.json"
if [ ! -f "$METADATA_FILE" ]; then
  echo "[rollback-migration] WARNING: No metadata file found at ${METADATA_FILE}" >&2
  echo "[rollback-migration] Cannot validate schema version compatibility." >&2
  echo "[rollback-migration] Delegating to file-level restore." >&2
  exec "${SCRIPT_DIR}/restore-db.sh" "$BACKUP_FILE"
fi

# Read pre-migration schema version from metadata
SCHEMA_VERSION_BEFORE="$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['schema_version_before'])" "$METADATA_FILE" 2>/dev/null || echo "")"

if [ -z "$SCHEMA_VERSION_BEFORE" ]; then
  echo "[rollback-migration] WARNING: Could not read schema_version_before from metadata." >&2
  SCHEMA_VERSION_BEFORE="unknown"
fi

if [ -z "$TARGET_VERSION" ]; then
  TARGET_VERSION="$SCHEMA_VERSION_BEFORE"
fi

echo "[rollback-migration] Backup: ${BACKUP_FILE}"
echo "[rollback-migration] Pre-migration schema version: ${SCHEMA_VERSION_BEFORE}"
echo "[rollback-migration] Target version: ${TARGET_VERSION}"

# --- Get current migration history ---
if ! command -v sqlite3 &>/dev/null; then
  echo "[rollback-migration] ERROR: sqlite3 is required for schema-aware rollback." >&2
  exit 1
fi

CURRENT_MIGRATIONS="$(sqlite3 "$DB_FILE" "SELECT name FROM __drizzle_migrations ORDER BY created_at ASC;" 2>/dev/null || echo "")"

if [ -z "$CURRENT_MIGRATIONS" ]; then
  echo "[rollback-migration] WARNING: No migrations found in __drizzle_migrations." >&2
  echo "[rollback-migration] Delegating to file-level restore." >&2
  exec "${SCRIPT_DIR}/restore-db.sh" "$BACKUP_FILE"
fi

# --- Identify migrations to roll back (in reverse order) ---
# Portable descending walk (bash 3.2 compatible, no tac/mapfile): collect
# ascending, then index from the end.
MIGRATION_NAMES=()
while IFS= read -r migration_name; do
  if [ -n "$migration_name" ]; then
    MIGRATION_NAMES+=("$migration_name")
  fi
done <<< "$CURRENT_MIGRATIONS"

ROLLBACK_LIST=()
FOUND_TARGET=false
idx=$((${#MIGRATION_NAMES[@]} - 1))
while [ "$idx" -ge 0 ]; do
  migration_name="${MIGRATION_NAMES[$idx]}"
  if [ "$migration_name" = "$TARGET_VERSION" ]; then
    FOUND_TARGET=true
    break
  fi
  ROLLBACK_LIST+=("$migration_name")
  idx=$((idx - 1))
done

if [ "$FOUND_TARGET" = false ] && [ "$TARGET_VERSION" != "none" ]; then
  echo "[rollback-migration] ERROR: Target version '${TARGET_VERSION}' not found in migration history." >&2
  echo "[rollback-migration] Available migrations:" >&2
  echo "$CURRENT_MIGRATIONS" | sed 's/^/  /' >&2
  exit 1
fi

if [ ${#ROLLBACK_LIST[@]} -eq 0 ]; then
  echo "[rollback-migration] No migrations to roll back. Already at target version."
  exit 0
fi

echo "[rollback-migration] Will roll back ${#ROLLBACK_LIST[@]} migration(s):"
for m in "${ROLLBACK_LIST[@]}"; do
  echo "[rollback-migration]   - ${m}"
done

# --- Verify down-migration files exist ---
MISSING_DOWN=()
for migration_name in "${ROLLBACK_LIST[@]}"; do
  DOWN_FILE="${DRIZZLE_DOWN_DIR}/${migration_name}.sql"
  if [ ! -f "$DOWN_FILE" ]; then
    MISSING_DOWN+=("$DOWN_FILE")
  fi
done

if [ ${#MISSING_DOWN[@]} -gt 0 ]; then
  echo "[rollback-migration] WARNING: Missing down-migration SQL files:" >&2
  for f in "${MISSING_DOWN[@]}"; do
    echo "[rollback-migration]   ${f}" >&2
  done
  echo "[rollback-migration] Generate them with: npx drizzle-kit generate --down" >&2
  echo "[rollback-migration] Delegating to file-level restore instead." >&2
  exec "${SCRIPT_DIR}/restore-db.sh" "$BACKUP_FILE"
fi

# --- Apply down-migrations in reverse order ---
echo "[rollback-migration] Applying down-migrations..."

for migration_name in "${ROLLBACK_LIST[@]}"; do
  DOWN_FILE="${DRIZZLE_DOWN_DIR}/${migration_name}.sql"
  echo "[rollback-migration] Applying: ${migration_name}"

  sqlite3 "$DB_FILE" <<EOF
BEGIN TRANSACTION;
.read ${DOWN_FILE}
DELETE FROM __drizzle_migrations WHERE name = '${migration_name}';
COMMIT;
EOF

  if [ $? -ne 0 ]; then
    echo "[rollback-migration] ERROR: Failed to apply down-migration: ${migration_name}" >&2
    echo "[rollback-migration] Database may be in an inconsistent state." >&2
    echo "[rollback-migration] Restore from backup: ./scripts/restore-db.sh '${BACKUP_FILE}'" >&2
    exit 1
  fi
done

# --- Verify integrity ---
echo "[rollback-migration] Verifying database integrity..."
INTEGRITY_RESULT="$(sqlite3 "$DB_FILE" "PRAGMA integrity_check;" 2>&1)" || true

if [ "$INTEGRITY_RESULT" != "ok" ]; then
  echo "[rollback-migration] ERROR: Integrity check failed after rollback." >&2
  echo "[rollback-migration] Result: ${INTEGRITY_RESULT}" >&2
  echo "[rollback-migration] Restore from backup: ./scripts/restore-db.sh '${BACKUP_FILE}'" >&2
  exit 1
fi

echo "[rollback-migration] Integrity check passed."
echo "[rollback-migration] Rollback complete. Current schema version: ${TARGET_VERSION}"
echo "[rollback-migration] Done."