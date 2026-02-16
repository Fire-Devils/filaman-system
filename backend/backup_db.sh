#!/bin/bash
set -e

BACKUP_DIR="${BACKUP_DIR:-/app/data/backups}"
DB_PATH="${DB_PATH:-/app/data/filaman.db}"
MAX_BACKUPS="${MAX_BACKUPS:-5}"

if [ ! -f "$DB_PATH" ]; then
    echo "Database not found: $DB_PATH"
    exit 0
fi

mkdir -p "$BACKUP_DIR"

TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_NAME="filaman_${TIMESTAMP}.db"
cp "$DB_PATH" "$BACKUP_DIR/$BACKUP_NAME"

echo "Backup created: $BACKUP_NAME"

cd "$BACKUP_DIR"
BACKUP_COUNT=$(ls -1 filaman_*.db 2>/dev/null | wc -l)
if [ "$BACKUP_COUNT" -gt "$MAX_BACKUPS" ]; then
    ls -t filaman_*.db | tail -n +$((MAX_BACKUPS + 1)) | xargs -r rm
    echo "Old backups cleaned. Remaining: $(ls -1 filaman_*.db | wc -l)"
fi
