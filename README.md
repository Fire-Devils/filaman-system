# FilaMan - Filament Management System

<a href="https://www.buymeacoffee.com/manuelw" target="_blank"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me A Coffee" style="height: 60px !important;width: 217px !important;" ></a>

### ♻️ Support Recycling Fabrik
Empty spools don't belong in the trash! We support the [Recycling Fabrik](https://recyclingfabrik.com/). Send your empty filament spools and 3D printing waste there to have it recycled into new filament.

*Looking for the German version? Read the [README.de.md](README.de.md).*

## About the Project
FilaMan is a comprehensive filament management system for 3D printing. It helps you keep track of your filament spools, manufacturers, colors, and current stock levels. It also features integrations with printers and AMS (Automatic Material System) units.

### 💡 Hardware Extension: FilaMan ESP32 Scale
To unlock the full potential of this system, we highly recommend our companion hardware project:
**[FilaMan-System-ESP32](https://github.com/Fire-Devils/FilaMan-System-ESP32)**
With this ESP32-based smart scale and RFID integration, you can simply place your spools on the scale, automatically measure the remaining weight, and sync the data seamlessly with this software via RFID tags!

### 🏠 Home Assistant Integration
If you are using Home Assistant, there is a very convenient Add-on available:
**[ha-filaman-system](https://github.com/netscout2001/ha-filaman-system)**
This allows you to install and run the FilaMan System directly within your Home Assistant environment with just a few clicks.

## Features
- **Spool Management:** Track remaining weight, location, and status.
- **Multi-User:** Role-based access control and tenant support.
- **Printer Integration:** Plugin system to connect with 3D printers and AMS units.
- **Database Support:** Works with SQLite (default), MySQL, and PostgreSQL.
- **Responsive UI:** Modern design with light, dark, and brand themes.

## 🗺️ Roadmap
We have exciting plans for the future of FilaMan:
- **Printer Plugins:** Develop plugins to connect with various 3D printers (community contributions are highly welcome!).
- **Mobile Apps:** Dedicated apps for iOS and Android.
- **Printable Labels:** Generate and print custom labels for your spools.
- **OIDC (OAuth2) Login:** Support for Single Sign-On (SSO) via OpenID Connect.

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

### Build Docker Container Yourself

#### Prerequisites
- Docker
- Docker Buildx with multi-architecture support (for ARM/AMD)

#### Build and Run
```bash
git clone https://github.com/Fire-Devils/filaman-system.git && cd filaman-system

# Build image
docker build -t filaman-system:latest .

# Or with docker-compose
docker-compose up --build

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
- Node.js 18+
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
npm run build
```
The static files will be in `frontend/dist/`.

## Configuration (Environment Variables)
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

## Project Structure

```text
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

## Technology

**Backend:**
- FastAPI
- SQLAlchemy 2.0 + Alembic
- Python 3.11+

**Frontend:**
- Astro + Tailwind CSS
- Static Build

## License
MIT