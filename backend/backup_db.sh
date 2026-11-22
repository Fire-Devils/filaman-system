#!/bin/bash
set -e

# Match the application's working directory even when cron starts in root's home.
cd -- "$(dirname -- "$0")"
exec python3 -m app.services.sqlite_backup
