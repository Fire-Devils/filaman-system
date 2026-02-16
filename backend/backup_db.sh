#!/bin/bash
set -e

BACKUP_DIR="${BACKUP_DIR:-/app/data/backups}"
DB_PATH="${DB_PATH:-/app/data/filaman.db}"
MAX_BACKUPS="${MAX_BACKUPS:-5}"

# Check if DATABASE_URL is set and contains sqlite
if [ -n "$DATABASE_URL" ] && [[ "$DATABASE_URL" == *"sqlite"* ]]; then
    # Use custom DB_PATH if set in DATABASE_URL
    if [[ "$DATABASE_URL" == *"://"* ]]; then
        # Extract path from sqlite URL (e.g., sqlite+aiosqlite:///./filaman.db)
        EXTRACTED_PATH=$(echo "$DATABASE_URL" | sed -n 's/.*:\/\/\/*.*\/\(.*\)/\1/p')
        if [ -n "$EXTRACTED_PATH" ]; then
            DB_PATH="$EXTRACTED_PATH"
        fi
    fi
elif [ -z "$DATABASE_URL" ]; then
    # Default SQLite path
    DB_PATH="/app/data/filaman.db"
else
    # External database (MySQL/PostgreSQL) - backup handled by admin
    echo "External database detected - backup is handled by admin"
    exit 0
fi

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
