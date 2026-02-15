# FilaMan - Filament Management System

A filament management system for 3D printing with spool tracking, AMS integration, and multi-user support.

## Tech Stack

**Backend:**
- FastAPI
- SQLAlchemy 2.0 + Alembic
- Python 3.11+

**Frontend:**
- Astro + Tailwind CSS
- Static Build

## Quick Start

### Prerequisites

- Python 3.11+
- Node.js 18+
- uv (Python package manager)

### Backend

```bash
cd backend
uv sync
uv run uvicorn app.main:app --reload
```

The API will be available at http://localhost:8000

### Frontend

```bash
cd frontend
npm install
npm run dev
```

The frontend will be available at http://localhost:4321

### Build Frontend for Production

```bash
cd frontend
npm run build
```

The static files will be in `frontend/dist/`.

## Project Structure

```
/
├── backend/
│   ├── app/
│   │   ├── core/          # Config, database, security
│   │   ├── modules/       # Domain modules
│   │   └── plugins/       # Printer plugins
│   ├── alembic/           # Database migrations
│   └── tests/             # Backend tests
├── frontend/
│   ├── src/
│   │   ├── pages/         # Astro pages
│   │   ├── layouts/       # Page layouts
│   │   └── components/    # UI components
│   └── dist/              # Production build
└── spec/                  # Project specifications
```

## Environment Variables

Create a `.env` file in the project root directory:

```env
DATABASE_URL=sqlite+aiosqlite:///./filaman.db
SECRET_KEY=your-secret-key
CSRF_SECRET_KEY=your-csrf-secret
ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD=secure-password
```

## License

MIT

## Docker Setup

This project is configured to run in a Docker container. This is the recommended way to run the application in production.

### Local Development with Docker

To build and run the application using Docker, use Docker Compose:

```bash
docker-compose up --build
```

The application will be available at http://localhost:8000.

**Note:** The `docker-compose.yml` is configured for development and uses the local SQLite database. For production, you should use a more robust database and manage your secrets securely.

### CI/CD with Gitea

This repository contains a Gitea workflow to automatically build and push the Docker image to the GitHub Container Registry (ghcr.io).

The workflow is defined in `.gitea/workflows/main.yml`.

**Setup:**

1.  **Update the workflow file:**
    Open `.gitea/workflows/main.yml` and replace `YOUR_GITEA_USERNAME` with your GitHub username.

2.  **Add Gitea Secrets:**
    In your Gitea repository settings, add the following secrets:
    *   `GHCR_USERNAME`: Your GitHub username.
    *   `GHCR_TOKEN`: A GitHub Personal Access Token (PAT) with `read:packages` and `write:packages` scopes.

Once configured, the workflow will trigger on every push to the `main` branch.

### Backend Configuration for Docker

To serve the frontend from the FastAPI backend when running in Docker, you need to configure your `main.py` to serve static files.

Add the following to your `backend/app/main.py`:

```python
from fastapi.staticfiles import StaticFiles

# ... your existing FastAPI app initialization
app = FastAPI()

# ... your existing routes and middleware

# Mount the static files directory
# This must be after all other routes
app.mount("/", StaticFiles(directory="/app/static", html=True), name="static")
```
