#!/bin/bash
set -e

if [ ! -d "/app/data" ]; then
  mkdir -p /app/data
fi

# Load .env but don't override existing environment variables
# Docker -e variables take precedence over .env file
if [ -f /app/.env ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    [[ "$line" =~ ^[^#] ]] && [[ -n "$line" ]] || continue
    key="${line%%=*}"
    eval "val=\$$key"
    if [ -z "$val" ]; then
      export "$line"
    fi
  done < /app/.env
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

# Cron already installed via Dockerfile
echo "0 2 * * * /app/backup_db.sh >> /var/log/backup.log 2>&1" > /etc/cron.d/filaman-backup
chmod 0644 /etc/cron.d/filaman-backup

cron

exec "$@"
