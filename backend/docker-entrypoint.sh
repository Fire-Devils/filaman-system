#!/bin/bash
set -e

# This script runs database migrations and then starts the main application.

# Ensure the data directory exists for the database
if [ ! -d "/app/data" ]; then
  mkdir -p /app/data
fi

# Load environment variables from .env file to ensure Alembic sees them
if [ -f /app/.env ]; then
  export $(grep -v '^#' /app/.env | xargs)
fi

# Run Alembic migrations
echo "Running database migrations..."

# DEBUG: Check environment variables
echo "--- DEBUG INFO START ---"
echo "Checking .env file:"
cat /app/.env || echo "Could not read /app/.env"
echo "------------------------"

alembic upgrade head

echo "Database migrations complete."

# DEBUG: Check created database file
echo "Checking database file location:"
ls -la /app/data/ || echo "Could not list /app/data"
ls -la /app/ || echo "Could not list /app"
echo "--- DEBUG INFO END ---"

# Execute the command passed to this script (e.g., uvicorn)
exec "$@"

