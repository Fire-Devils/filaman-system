#!/bin/bash
set -e

if [ ! -d "/app/data" ]; then
  mkdir -p /app/data
fi
chmod 700 /app/data

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

# The backup script handles the configured SQLite path and skips new/external databases.
# A failed startup backup must not block migrations and startup (set -e would crash-loop the container).
if ! /app/backup_db.sh; then
    echo "WARNING: startup backup failed, continuing without a fresh backup" >&2
fi

echo "Running migrations..."
alembic upgrade head
echo "Database migrations complete."

# Cron already installed via Dockerfile
# Cron has its own environment; retain only the backup configuration, privately quoted by Bash.
(umask 077
  for name in DATABASE_URL DB_PATH BACKUP_DIR MAX_BACKUPS; do
    declare -p "$name" 2>/dev/null || true
  done > /run/filaman-backup.env
)
chmod 0600 /run/filaman-backup.env
printf '%s\n' 'PATH=/usr/local/bin:/usr/bin:/bin' "0 2 * * * root /bin/bash -c 'set -a; source /run/filaman-backup.env; exec /app/backup_db.sh' >> /var/log/backup.log 2>&1" > /etc/cron.d/filaman-backup
chmod 0644 /etc/cron.d/filaman-backup

# Start cron
cron

# Start nginx (serves static files, proxies API to Gunicorn)
echo "Starting nginx..."
nginx

exec "$@"
