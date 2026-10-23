# FilaMan - Filament Management System

### Support the FilaMan Project
[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/X8X51V6SLP)

### ♻️ Support Recycling Fabrik
Empty spools don't belong in the trash! We support the [Recycling Fabrik](https://recyclingfabrik.com/). Send your empty filament spools and 3D printing waste there to have it recycled into new filament.

**Exciting News:** Recycling Fabrik is the first manufacturer that will soon start shipping their filament spools with pre-programmed, FilaMan-compatible RFID tags!

*Looking for the German version? Read the [README.de.md](README.de.md).*

## About the Project
FilaMan is a comprehensive filament management system for 3D printing. It helps you keep track of your filament spools, manufacturers, colors, and current stock levels. It also features integrations with printers and AMS (Automatic Material System) units.

### Documentation
The full user manual is available at **[docu.filaman.app](https://docu.filaman.app)**.
See the [label rendering and print-request API](docs/label-api.md) for device and client integration.

### 💡 Hardware Extension: FilaMan ESP32 Scale
To unlock the full potential of this system, we highly recommend our companion hardware project:
**[FilaMan-System-ESP32](https://github.com/Fire-Devils/FilaMan-System-ESP32)**
With this ESP32-based smart scale and RFID integration, you can simply place your spools on the scale, automatically measure the remaining weight, and sync the data seamlessly with this software via RFID tags!

### 🏠 Home Assistant Integration
If you are using Home Assistant, install FilaMan from our add-on repository:
**[Fire-Devils/filaman-ha-app](https://github.com/Fire-Devils/filaman-ha-app)**
Add that URL under Settings → Add-ons → Add-on store → ⋮ → Repositories, then install FilaMan and run it directly inside your Home Assistant environment.

### 🎋 Bambuddy Integration
Connect FilaMan to Bambu Lab printers and AMS units with the
**[Bambuddy driver plugin](https://github.com/Fire-Devils/filaman-bambuddy-plugin)**.
The integration keeps spool and AMS information in sync, supports automatic
assignment after weighing and inserting a spool, and reports filament usage
back to FilaMan.

When used with Bambuddy, FilaMan can also apply your custom, Bambu
Cloud-synced slicer profiles automatically when a spool is placed in an AMS
slot. The correct material profile is then available in both the AMS and Bambu
Studio, giving custom and third-party filament much the same seamless workflow
as an official Bambu RFID spool.

## Features
- **Spool Management:** Track remaining weight, location, and status.
- **Filament and Spool Details:** Consistent product and inventory pages with manufacturer logos, multicolor swatches, quick actions, and sticky edit/save controls. Filament Create and Edit share one responsive form.
- **Standard Filament Properties:** Manage temperature ranges, drying, cooling, print behavior, compatibility, product links, and default spool dimensions alongside typed system and record-specific extra fields.
- **Catalogs and Imports:** Search FilaManDB for filament data and spool profiles, including available packaging photos. Import Spoolman inventory and promote compatible recognized extras into standard properties while preserving incompatible or ambiguous values.
- **Purchase Tracking:** Record spool purchase prices in one app currency. Filament catalog prices retain their source currency; mismatched currencies are not automatically converted or suggested for new spool purchases.
- **Dual RFID Tags:** Store two RFID tag UIDs per spool, so either side of a dual-tag spool can identify the same inventory item.
- **Multi-User:** Role-based access control and tenant support.
- **Printer Integration:** Plugin system to connect with 3D printers and AMS units.
- **Bambuddy Integration:** Synchronize spool inventory and AMS assignments, track filament use, and automatically apply custom Bambu Cloud slicer profiles.
- **Printable Labels:** Design spool or filament labels on a freeform canvas with text, QR codes, images, and shapes. Use grouped, searchable native and extra-field tokens, reusable presets, PNG/PDF exports, and label-paper sheet output.
- **Label API:** Render spool or filament labels and submit print requests for supported devices using the same SVG renderer as the browser designer. See [the API guide](docs/label-api.md).
- **Database Support:** Works with SQLite (default), MySQL, and PostgreSQL.
- **Responsive UI:** Modern design with light, dark, and brand themes.
- **OIDC (OAuth2) Login:** Single Sign-On (SSO) via OpenID Connect for existing users.

## 🗺️ Roadmap
We have exciting plans for the future of FilaMan:
- **Printer Plugins:** Develop plugins to connect with various 3D printers (community contributions are highly welcome!).
- **Mobile Apps:** Dedicated apps for iOS and Android.

## Installation

### Quick Start (Docker)
The easiest way to start FilaMan is using Docker:

```bash
docker run -d \
  --name filaman-system-app \
  --restart unless-stopped \
  --pull always \
  -p 8083:8000 \
  -v filaman_data:/app/data \
  ghcr.io/fire-devils/filaman-system:latest
```

The application will be available at `http://localhost:8083`.
- **Default Email:** `admin@example.com`
- **Default Password:** `admin123`

Labels use a shared SVG/WASM renderer for the designer, exports and API.
The image packages Node 20 and fonts; no server browser is required. SVG is the
only label renderer, with no renderer selector or fallback. Container checks pass on native
ARM64 and emulated AMD64/ARMv7; physical print/scan acceptance is still pending.
See [API documentation](docs/label-api.md).

### Build Docker Container Yourself

#### Prerequisites
- Docker
- Docker Buildx with multi-architecture support (for ARM/AMD)

#### Build and Run
```bash
git clone https://github.com/Fire-Devils/filaman-system.git && cd filaman-system

# On a fresh checkout, create .env from .env.example before building.
# Keep an existing .env; configure secrets and admin credentials as needed.
test -e .env || cp .env.example .env

# Build image
docker build -t filaman-system:latest .

# Or build and run with Docker Compose (PORT is the host port)
PORT=8083 docker compose -f docker-compose.build.yml up --build -d

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

The build Compose file uses a host bind mount at `/home/docker/filaman`;
adjust it to your data directory before running. To run the published image
instead, use `PORT=8083 docker compose up -d`. The standalone `docker run`
example above uses a named volume.

## Local Development

#### Prerequisites
- Python 3.11+
- Node.js 22+ (or 20.3+); the shared label-rendering bundle targets Node 20
- uv (Python Package Manager)

#### Configure Local Development
From the repository root, create `.env` from `.env.example` if it does not
already exist. For local SQLite development, replace the Docker-only
`/app/data/filaman.db` path with:

```dotenv
DATABASE_URL=sqlite+aiosqlite:///./filaman.db
```

Set `ADMIN_EMAIL` and `ADMIN_PASSWORD` in `.env` for the initial account.
Relative SQLite paths are resolved from the repository root. Startup applies
database migrations automatically.

#### Start Backend
```bash
cd backend
uv sync --frozen
uv run uvicorn app.main:app --reload
```
The API will be available at `http://localhost:8000`.

#### Start Frontend
```bash
cd frontend
npm ci
npm run build:label-svg
npm run dev
```
The frontend will be available at `http://localhost:4321`.
Keep the backend running in another terminal. The development server proxies
API and authentication requests to `http://localhost:8000`; set `BACKEND_URL`
when using a different backend address.

`build:label-svg` generates the Node/fonts/WASM bundle required by backend
label rendering. Rebuild it after changing the shared renderer. Without the
bundle, render endpoints return `503`. See [renderer setup](docs/label-api.md#shared-svg-rendering).

For backend tests, install development dependencies with
`uv sync --frozen --extra dev` from `backend`.

#### Build Frontend for Production
```bash
cd frontend
BUILD_MODE=static npm exec astro build
```
The static files and shared label-rendering bundle will be in `frontend/dist/`.
This matches the Docker frontend build mode without rewriting version metadata.
Without `BUILD_MODE=static`, Astro defaults to a standalone Node server build,
not static output. Docker packages the static output with the backend; see
the Docker build instructions above for a complete deployment.

## Configuration (Environment Variables)
Create a `.env` file in the project root directory. Use `.env.example` as a template:

```bash
# Database Configuration
# SQLite (default):
DATABASE_URL=sqlite+aiosqlite:///./filaman.db

# MySQL:
# DATABASE_URL=mysql+aiomysql://username:password@hostname:3306/database

# PostgreSQL:
# DATABASE_URL=postgresql+asyncpg://username:password@hostname:5432/database
```

#### Generate Secrets
```bash
# Generate single secret
openssl rand -hex 32

# Generate all secrets at once
echo "SECRET_KEY=$(openssl rand -hex 32)"
echo "CSRF_SECRET_KEY=$(openssl rand -hex 32)"
echo "OIDC_ENC_KEY=$(openssl rand -hex 32)"
```

#### OIDC / SSO Configuration
To enable OIDC (OpenID Connect) login, set the following environment variable:

```bash
# Required for encrypting the OIDC client secret in the database
OIDC_ENC_KEY=your-fernet-key
```

**Note:** When using MySQL or PostgreSQL, backups must be managed externally by the administrator. The automatic SQLite backup is disabled in this case.

## Project Structure

```text
/
├── backend/
│   ├── app/
│   │   ├── api/           # HTTP routes and schemas
│   │   ├── core/          # Config, database, security
│   │   ├── models/        # Database models
│   │   ├── services/      # Imports and shared domain logic
│   │   └── plugins/       # Plugin integration
│   ├── alembic/           # Database migrations
│   └── tests/             # Backend tests
├── frontend/
│   ├── src/
│   │   ├── pages/         # Astro pages
│   │   ├── layouts/       # Page layouts
│   │   ├── components/    # UI components
│   │   └── lib/           # Shared UI and label-rendering code
│   └── dist/              # Production build
└── docs/                  # API and development documentation
```

## Technology

**Backend:**
- FastAPI
- SQLAlchemy 2.0 + Alembic
- Python 3.11+

**Frontend:**
- Astro + Tailwind CSS
- Static Docker build; standalone Node server output by default for source builds
- Shared SVG/WASM label rendering in the browser and Node runtime

## License
MIT
