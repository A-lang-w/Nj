#!/usr/bin/env bash
# backup-db.sh — Consistent SQLite backup via the online backup API.
#
# Usage: ./scripts/backup-db.sh   (or: npm run db:backup)
#
# Uses `sqlite3 .backup` so the snapshot is consistent even while the server
# is running under WAL mode; a plain `cp` of hyperagent.db can omit
# uncheckpointed -wal frames. Keeps the 7 most recent backups.
#
# Environment:
#   DATA_DIR — directory containing hyperagent.db (default: ./data)
set -euo pipefail

if ! command -v sqlite3 &>/dev/null; then
  echo "[backup-db] ERROR: sqlite3 CLI is required but not found in PATH." >&2
  exit 1
fi

DATA_DIR="${DATA_DIR:-./data}"
DB_FILE="${DATA_DIR}/hyperagent.db"
if [ ! -f "$DB_FILE" ]; then
  echo "[backup-db] ERROR: Database file not found at ${DB_FILE}" >&2
  exit 1
fi

BACKUP_DIR="${DATA_DIR}/backups"
mkdir -p "$BACKUP_DIR"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="$BACKUP_DIR/hyperagent_${TIMESTAMP}.db"
sqlite3 "$DB_FILE" ".backup '$BACKUP_FILE'"
echo "Backup created: $BACKUP_FILE"
# Keep only last 7 backups
ls -t "$BACKUP_DIR"/hyperagent_*.db 2>/dev/null | tail -n +8 | while IFS= read -r f; do rm -f "$f"; done
