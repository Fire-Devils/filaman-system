#!/bin/bash
set -e

if [ ! -d "/app/data" ]; then
  mkdir -p /app/data
fi

if [ -f /app/.env ]; then
  export $(grep -v '^#' /app/.env | xargs)
fi

echo "Checking for database migrations..."
ALEMBIC_DRY_RUN=$(alembic upgrade head --dry-run 2>&1 || true)

if echo "$ALEMBIC_DRY_RUN" | grep -q "will upgrade"; then
    echo "Migration required - creating backup first..."
    
    chmod +x /app/backup_db.sh
    /app/backup_db.sh
    
    echo "Running migration..."
    alembic upgrade head
    echo "Migration complete."
else
    echo "No migration required."
fi

if ! command -v crond &> /dev/null; then
    apt-get update && apt-get install -y cron
fi

echo "0 2 * * * /app/backup_db.sh >> /var/log/backup.log 2>&1" > /etc/cron.d/filaman-backup
chmod 0644 /etc/cron.d/filaman-backup

crond

exec "$@"
