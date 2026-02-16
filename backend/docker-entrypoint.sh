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

# Ensure backup script is executable
chmod +x /app/backup_db.sh

# Only backup if the database file exists and has size > 0
# Path adjusted to /app/data/filaman.db as requested
if [ -f "/app/data/filaman.db" ] && [ -s "/app/data/filaman.db" ]; then
    echo "Existing database found, creating backup..."
    /app/backup_db.sh
fi

echo "Running migrations..."
alembic upgrade head
echo "Database migrations complete."

# Cron already installed via Dockerfile
echo "0 2 * * * /app/backup_db.sh >> /var/log/backup.log 2>&1" > /etc/cron.d/filaman-backup
chmod 0644 /etc/cron.d/filaman-backup

# Start cron
cron

exec "$@"
