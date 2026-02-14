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

Create a `.env` file in the backend directory:

```env
DATABASE_URL=sqlite+aiosqlite:///./filaman.db
SECRET_KEY=your-secret-key
CSRF_SECRET_KEY=your-csrf-secret
ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD=secure-password
```

## License

MIT
