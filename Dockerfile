# syntax=docker/dockerfile:1

# --- Frontend Build Stage ---
FROM node:20-slim AS frontend-builder

WORKDIR /app/frontend

# Copy package manifests
COPY frontend/package.json frontend/package-lock.json* ./

# Install dependencies
RUN npm install --production

# Copy frontend source
COPY frontend/ ./

# Copy version.txt before build so it can be embedded into the frontend
COPY version.txt ./

# Build the frontend
RUN BUILD_MODE=static npm run build

# --- Backend Build Stage ---
FROM python:3.11-slim-trixie AS backend-builder

WORKDIR /app/backend

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    pkg-config \
    libffi-dev \
    libfreetype6-dev \
    default-libmysqlclient-dev \
    libpq-dev \
    libjpeg-dev \
    zlib1g-dev \
    && rm -rf /var/lib/apt/lists/*

# Install uv
RUN pip install uv

# Copy backend dependency files
COPY backend/pyproject.toml backend/uv.lock ./

# Install backend dependencies
RUN uv pip install --system --no-cache -r pyproject.toml

# Copy backend source
COPY backend/ ./

# --- Final Image Stage ---
FROM python:3.11-slim-trixie

WORKDIR /app

# Set environment variables
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

# Disable in-app migrations because the entrypoint handles them
ENV RUN_MIGRATIONS_IN_APP=false
ENV LABEL_RENDER_CHROMIUM_EXECUTABLE=/usr/lib/chromium/chromium-headless-shell
ENV LABEL_RENDER_CHROMIUM_USER=label-render
ARG DEFAULT_LABEL_RENDERER=basic
ENV LABEL_RENDERER=${DEFAULT_LABEL_RENDERER}

# Install uv, services, and the Pillow runtime libraries used by ARMv7 source builds.
RUN pip install uv && apt-get update && apt-get install -y cron nginx libjpeg62-turbo libfreetype6 && rm -rf /var/lib/apt/lists/*
RUN groupadd --system label-render \
    && useradd --system --gid label-render --no-create-home --shell /usr/sbin/nologin label-render

# Copy installed dependencies from backend-builder
COPY --from=backend-builder /usr/local/lib/python3.11/site-packages /usr/local/lib/python3.11/site-packages
COPY --from=backend-builder /usr/local/bin /usr/local/bin

# The default image stays small; the -chromium image enables shared-preview rendering.
ARG INSTALL_LABEL_BROWSER=false
RUN if [ "$INSTALL_LABEL_BROWSER" = "true" ]; then \
      apt-get update && apt-get install -y --no-install-recommends chromium-headless-shell chromium-sandbox; \
    fi \
    && rm -rf /var/lib/apt/lists/*

# Copy backend application
COPY --from=backend-builder /app/backend /app

# Copy the generated .env file for production
COPY .env /app/.env
RUN chmod 600 /app/.env

# Copy built frontend to the static directory
# The FastAPI app must be configured to serve static files from this directory.
COPY --from=frontend-builder /app/frontend/dist /app/static

# Copy version.txt so the backend can read the installed version
COPY version.txt /app/version.txt

# Copy backup script
COPY backend/backup_db.sh /app/backup_db.sh
RUN chmod +x /app/backup_db.sh

# Copy nginx configuration
COPY nginx.conf /etc/nginx/nginx.conf

# Expose the port the app runs on
EXPOSE 8000

# Health check using the /health endpoint
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/health')" || exit 1

# Copy entrypoint script and make it executable
COPY backend/docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Set the entrypoint
ENTRYPOINT ["docker-entrypoint.sh"]

# The command to run the application with Gunicorn and multiple Uvicorn workers
# nginx (port 8000) -> Gunicorn (port 8001) for static file performance
CMD ["gunicorn", "-w", "4", "-k", "uvicorn.workers.UvicornWorker", "--bind", "127.0.0.1:8001", "--timeout", "120", "--keep-alive", "5", "--pid", "/tmp/filaman-gunicorn.pid", "--access-logfile", "-", "app.main:app"]
