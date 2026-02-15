#!/bin/bash
set -e

# This script runs database migrations and then starts the main application.

# Ensure the data directory exists for the database
if [ ! -d "/app/data" ]; then
  mkdir -p /app/data
fi

# Run Alembic migrations in a subshell to avoid blocking the main process
echo "Running database migrations..."
# The \\ escapes the pipe symbol, so it's passed correctly to the subshell
alembic upgrade head \
  --raise-error-on-failed-init \
  --raise-error-on-data-error
echo "Database migrations complete."

# Execute the command passed to this script (e.g., uvicorn)
exec "$@"

