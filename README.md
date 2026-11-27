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
The full user manual is available at **[docu.filaman.app](https://docu.filaman.app)**. It is available in German and English and includes screenshots.

To browse, install, or submit plugins, see the [plugin catalog guide](plugin-catalog/README.md).
See the [label rendering and print-request API](docs/label-api.md) for device and client integration.

### 💡 Hardware Extension: FilaMan ESP32 Scale
To unlock the full potential of this system, we highly recommend our companion hardware project:
**[FilaMan-System-ESP32](https://github.com/Fire-Devils/FilaMan-System-ESP32)**
With this ESP32-based smart scale and RFID integration, you can simply place your spools on the scale, automatically measure the remaining weight, and sync the data seamlessly with this software via RFID tags!

- **Firmware updates over Wi-Fi:** Upload or import scale firmware under Admin > Devices; the scales fetch it from the FilaMan server themselves. See [Scale Firmware Updates](https://docu.filaman.app/Docs/En/21-Firmware-Updates).
- **"Spool full" at the scale:** Weigh a full spool and long-press the touch button to calculate the empty spool weight and set the remaining weight to the nominal weight. See [Scale: setup and operation](https://docu.filaman.app/Docs/En/28-Scale).

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

**Inventory**
- **Spool Management:** Track remaining weight, estimated metres and percentage, location, and status.
- **Filament and Spool Details:** Consistent, responsive pages with quick actions and in-place editing.
- **Standard Filament Properties:** Temperature ranges, drying recommendations, print settings, and dimensions alongside typed extra fields.
- **Material Presets:** Store default nozzle and bed temperature, flow ratio, drying, drying interval and density per material; new filaments take them over into empty fields.
- **Color Library:** Reusable colors with transparency and a visual color filter; duplicate colors can be compared and merged (also with differing HEX values) while keeping all filament assignments.
- **Moisture and Abrasive Filament:** Tracks when a spool was opened or dried and shows a material-based moisture status; abrasive filaments are flagged, with warnings for non-hardened nozzles.
- **Purchase Value and Remaining Value:** Each spool's purchase price pro rata by remaining weight, shown on the dashboard, manufacturer view, spool detail page and as a spool list column.
- **Dual RFID Tags:** Store two RFID tag UIDs per spool, so either side of a dual-tag spool can identify the same inventory item.

**Catalogs and Community**
- **Catalogs and Imports:** Search FilaManDB for filament specifications and import existing inventory from Spoolman.
- **FilaMan-DB Community:** Send manufacturers, filaments and print profiles to the community database after a preview, match your entries against it in bulk, and use "Check for updates" to compare linked filaments with the current data.
- **Print Profiles:** Per filament and printer model: temperatures, speed, flow/pressure advance, retraction and fan, plus community print profiles you can adopt.

**Printing and Analysis**
- **Print Jobs, Projects and Slicer Link:** Log prints with projects and costs and deduct filament from spools; a script for PrusaSlicer, OrcaSlicer, BambuStudio and Cura reports sliced jobs, and consumption is only booked after you confirm.
- **Analytics:** Consumption and costs by month, material and manufacturer, plus purchases, print statistics and top projects.
- **Printable Labels and Label Designer:** Print and export spool or filament labels with QR codes, a freeform millimetre-accurate designer, grouped and searchable field tokens, and label-paper sheet output.
- **AMS View:** Live overview of the AMS units and slots per printer with color, material and remaining amount; kiosk mode for a wall display.

**Integrations and Extensibility**
- **Printer Integration:** Plugin system to connect with 3D printers and AMS units. Plugin authors can supply [custom icon assets](docs/plugin-icons.md).
- **Bambuddy Integration:** Synchronize spool inventory and AMS assignments, track filament use, and automatically apply custom Bambu Cloud slicer profiles.
- **Plugin Catalog and Plugin Buttons:** Browse and install plugins from a curated catalog; plugins can add their own buttons to the filament editor, the filament list and the color library.
- **AI Access (MCP):** AI assistants such as Claude, Cursor, VS Code, Codex or Gemini can query FilaMan through the built-in MCP server and, if allowed, maintain spools, filaments and locations.
- **ESP32 Scale:** Firmware updates over Wi-Fi from the FilaMan server and a "Spool full" function at the scale (see below).

**Platform**
- **Multi-User:** Role-based access control and tenant support.
- **OIDC (OAuth2) Login:** Single Sign-On (SSO) via OpenID Connect for existing users.
- **Database Support:** Works with SQLite (default), MySQL, and PostgreSQL.
- **Responsive UI:** Modern design with light, dark, and brand themes; available in English, German and French.

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

# Create .env if needed, then configure it.
test -e .env || cp .env.example .env

# Build image
docker build -t filaman-system:latest .

# Or use Docker Compose (adjust its data-volume path first)
PORT=8083 docker compose -f docker-compose.build.yml up --build

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

## Local Development

#### Prerequisites
- Python 3.11+
- Node.js 20.3+
- uv (Python Package Manager)

#### Start Backend
```bash
cd backend
uv sync
uv run uvicorn app.main:app --reload
```
The API will be available at `http://localhost:8000`.

#### Start Frontend
```bash
cd frontend
npm install
npm run dev
```
The frontend will be available at `http://localhost:4321`.

#### Build Frontend for Production
```bash
cd frontend
BUILD_MODE=static npx astro build
```
The static files will be in `frontend/dist/`.

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

#### Worker Processes
The Docker image starts 4 worker processes by default. Each one holds a full copy of the application (about 90 MB), so on a small host such as a Raspberry Pi you can run fewer:

```bash
# Default: 4. A single worker runs the printer drivers itself, nothing is forwarded.
WEB_CONCURRENCY=1
```

#### Other Settings
```bash
# Public address of FilaMan (incl. path prefix behind a reverse proxy).
# Adds a link to the spool detail page (web_url) to API responses, e.g. for QR codes. Empty = off.
PUBLIC_URL=https://filaman.example.com

# FilaMan-DB community database used for lookup, import and submissions (default: https://db.filaman.app)
FILAMENTDB_URL=https://db.filaman.app

# Optional: comma-separated plugin tool names that plugins may expose on the built-in MCP server
MCP_PLUGIN_READ_TOOLS=
```

**Note:** When using MySQL or PostgreSQL, backups must be managed externally by the administrator. The automatic SQLite backup is disabled in this case.

## Project Structure

```text
/
├── backend/
│   ├── app/
│   │   ├── api/           # REST API (v1), auth, built-in MCP server
│   │   ├── core/          # Config, database, security
│   │   ├── models/        # Database models
│   │   ├── services/      # Shared domain logic
│   │   ├── plugins/       # Plugin system and bundled plugins (e.g. FilamentDB Import)
│   │   ├── slicer_link/   # Slicer-Link script
│   │   └── utils/         # Helpers
│   ├── alembic/           # Database migrations
│   └── tests/             # Backend tests
├── frontend/
│   ├── src/
│   │   ├── pages/         # Astro pages
│   │   ├── layouts/       # Page layouts
│   │   ├── components/    # UI components
│   │   ├── lib/           # Client logic and helpers
│   │   ├── i18n/          # Translations (en, de, fr)
│   │   ├── types/         # TypeScript types
│   │   └── changelog.json # In-app changelog
│   └── dist/              # Production build
├── plugin-catalog/        # Curated plugin catalog
└── docs/                  # Project documentation
```

## Technology

**Backend:**
- FastAPI
- SQLAlchemy 2.0 + Alembic
- Python 3.11+
- Gunicorn/Uvicorn behind nginx (Docker image)

**Frontend:**
- Astro + Tailwind CSS
- TypeScript, translations in `src/i18n`
- Static Docker build; Node server output for source builds

## License
MIT
