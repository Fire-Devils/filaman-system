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

# Build the frontend
RUN npm run build

# --- Backend Build Stage ---
FROM python:3.11-slim AS backend-builder

WORKDIR /app/backend

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    pkg-config \
    libffi-dev \
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
FROM python:3.11-slim

WORKDIR /app

# Set environment variables
ENV PYTHONDONTWRITEBYTECODE 1
ENV PYTHONUNBUFFERED 1

# Install uv in the final image
RUN pip install uv

# Copy installed dependencies from backend-builder
COPY --from=backend-builder /usr/local/lib/python3.11/site-packages /usr/local/lib/python3.11/site-packages
COPY --from=backend-builder /usr/local/bin /usr/local/bin

# Copy backend application
COPY --from=backend-builder /app/backend /app

# Copy the generated .env file for production
COPY .env /app/.env

# Copy built frontend to the static directory
# The FastAPI app must be configured to serve static files from this directory.
COPY --from=frontend-builder /app/frontend/dist /app/static

# Expose the port the app runs on
EXPOSE 8000

# Copy entrypoint script and make it executable
COPY backend/docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Set the entrypoint
ENTRYPOINT ["docker-entrypoint.sh"]

# The command to run the application
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
