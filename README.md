# FilaMan - Filament Management System

A filament management system for 3D printing with spool tracking, AMS integration, and multi-user support.

---

## Deutsch

### Schnellstart (Docker)

Der einfachste Weg, FilaMan zu starten:

```bash
docker run -d \
  --name filaman-system-app \
  --restart unless-stopped \
  --pull always \
  -p 8083:8000 \
  -v filaman_data:/app/data \
  ghcr.io/fire-devils/filaman-system:latest
```

Die Anwendung ist dann unter http://localhost:8083 erreichbar.

Default EMail: admin@example.com
Default Passwort: admin123

### Docker Container selber bauen

#### Voraussetzungen

- Docker
- Docker Buildx mit Multi-Architektur-Unterstützung (für ARM/AMD)

#### Build

```bash
# Clone repo
git clone https://github.com/Fire-Devils/filaman-system.git && cd filaman-system

# Image bauen
docker build -t filaman-system:latest .

# Oder mit docker-compose
docker-compose up --build
```

#### Ausführen

```bash
# Container starten
docker run -d \
  --name filaman-system-app \
  --restart unless-stopped \
  -p 8083:8000 \
  -v filaman_data:/app/data \
  -e DEBUG=false \
  -e SECRET_KEY=your-secret-key \
  -e CSRF_SECRET_KEY=your-csrf-secret \
  -e ADMIN_EMAIL=admin@example.com \
  -e ADMIN_PASSWORD=your-admin-password \
  filaman-system:latest
```

### Lokale Entwicklung

#### Voraussetzungen

- Python 3.11+
- Node.js 18+
- uv (Python Package Manager)

#### Backend starten

```bash
cd backend
uv sync
uv run uvicorn app.main:app --reload
```

Das Backend ist unter http://localhost:8000 verfügbar.

#### Frontend starten

```bash
cd frontend
npm install
npm run dev
```

Das Frontend ist unter http://localhost:4321 verfügbar.

#### Frontend für Produktion bauen

```bash
cd frontend
npm run build
```

Die statischen Dateien liegen in `frontend/dist/`.

### Umgebungsvariablen

Erstelle eine `.env` Datei im Projektverzeichnis. Verwende `.env.example` als Vorlage:

```bash
# Datenbank-Konfiguration
# SQLite (Standard):
DATABASE_URL=sqlite+aiosqlite:///./filaman.db

# MySQL:
# DATABASE_URL=aiomysql://username:password@hostname:3306/database

# PostgreSQL:
# DATABASE_URL=asyncpg://username:password@hostname:5432/database
```

#### Secrets generieren

```bash
# Einzelne Secrets generieren
openssl rand -hex 32

# Alle Secrets auf einmal generieren
echo "SECRET_KEY=$(openssl rand -hex 32)"
echo "CSRF_SECRET_KEY=$(openssl rand -hex 32)"
```

**Hinweis:** Bei Verwendung von MySQL oder PostgreSQL muss das Backup vom Administrator extern verwaltet werden. Das automatische SQLite-Backup ist in diesem Fall deaktiviert.

### Projektstruktur

```
/
├── backend/
│   ├── app/
│   │   ├── core/          # Konfiguration, Datenbank, Sicherheit
│   │   ├── modules/       # Domain-Module
│   │   └── plugins/       # Drucker-Plugins
│   ├── alembic/           # Datenbank-Migrationen
│   └── tests/             # Backend-Tests
├── frontend/
│   ├── src/
│   │   ├── pages/         # Astro-Seiten
│   │   ├── layouts/       # Seiten-Layouts
│   │   └── components/    # UI-Komponenten
│   └── dist/              # Produktions-Build
└── spec/                  # Projektspezifikationen
```

### Technologie

**Backend:**
- FastAPI
- SQLAlchemy 2.0 + Alembic
- Python 3.11+

**Frontend:**
- Astro + Tailwind CSS
- Statischer Build

### Lizenz

MIT

---

## English

### Quick Start (Docker)

The easiest way to start FilaMan:

```bash
docker run -d \
  --name filaman-system-app \
  --restart unless-stopped \
  --pull always \
  -p 8083:8000 \
  -v filaman_data:/app/data \
  ghcr.io/fire-devils/filaman-system:latest
```

The application will be available at http://localhost:8083.

### Build Docker Container Yourself

#### Prerequisites

- Docker
- Docker Buildx with multi-architecture support (for ARM/AMD)

#### Get repo
git clone https://github.com/Fire-Devils/filaman-system.git && cd filaman-system

#### Build

```bash
# Clone repo
git clone https://github.com/Fire-Devils/filaman-system.git && cd filaman-system

# Build image
docker build -t filaman-system:latest .

# Or with docker-compose
docker-compose up --build
```

#### Run

```bash
# Start container
docker run -d \
  --name filaman-system-app \
  --restart unless-stopped \
  -p 8083:8000 \
  -v filaman_data:/app/data \
  -e DEBUG=false \
  -e SECRET_KEY=your-secret-key \
  -e CSRF_SECRET_KEY=your-csrf-secret \
  -e ADMIN_EMAIL=admin@example.com \
  -e ADMIN_PASSWORD=your-admin-password \
  filaman-system:latest
```

### Local Development

#### Prerequisites

- Python 3.11+
- Node.js 18+
- uv (Python package manager)

#### Start Backend

```bash
cd backend
uv sync
uv run uvicorn app.main:app --reload
```

The API will be available at http://localhost:8000.

#### Start Frontend

```bash
cd frontend
npm install
npm run dev
```

The frontend will be available at http://localhost:4321.

Default EMail: admin@example.com
Default Password: admin123

#### Build Frontend for Production

```bash
cd frontend
npm run build
```

The static files will be in `frontend/dist/`.

### Environment Variables

Create a `.env` file in the project root directory. Use `.env.example` as a template:

```bash
# Database Configuration
# SQLite (default):
DATABASE_URL=sqlite+aiosqlite:///./filaman.db

# MySQL:
# DATABASE_URL=aiomysql://username:password@hostname:3306/database

# PostgreSQL:
# DATABASE_URL=asyncpg://username:password@hostname:5432/database
```

#### Generate Secrets

```bash
# Generate single secret
openssl rand -hex 32

# Generate all secrets at once
echo "SECRET_KEY=$(openssl rand -hex 32)"
echo "CSRF_SECRET_KEY=$(openssl rand -hex 32)"
```

**Note:** When using MySQL or PostgreSQL, backups must be managed externally by the administrator. The automatic SQLite backup is disabled in this case.

### Project Structure

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

### Technology

**Backend:**
- FastAPI
- SQLAlchemy 2.0 + Alembic
- Python 3.11+

**Frontend:**
- Astro + Tailwind CSS
- Static Build

### License

MIT
