#!/bin/bash
set -e

# This script runs database migrations and then starts the main application.

# Navigate to the app directory where alembic.ini should be found
cd /app

# Run Alembic migrations
echo "Running database migrations..."
alembic upgrade head
echo "Database migrations complete."

# Execute the command passed to this script (e.g., uvicorn)
exec "$@"
