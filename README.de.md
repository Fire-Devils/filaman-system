# FilaMan - Filament Management System

<a href="https://www.buymeacoffee.com/manuelw" target="_blank"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me A Coffee" style="height: 40px !important;width: 145px !important;" ></a>

### ♻️ Unterstütze die Recycling Fabrik
Leere Spulen gehören nicht in den Müll! Wir unterstützen die [Recycling Fabrik](https://recyclingfabrik.com/). Sende deine leeren Filamentspulen und 3D-Druck-Reste dorthin, damit daraus wieder neues Filament gewonnen werden kann.

**Spannende Neuigkeiten:** Die Recycling Fabrik ist der erste Hersteller, der demnächst damit starten wird, seine Filamentspulen ab Werk mit vorprogrammierten, FilaMan-kompatiblen RFID-Tags auszuliefern!

*Auf der Suche nach der englischen Version? Lese die [README.md](README.md).*

## Über das Projekt
FilaMan ist ein umfassendes System zur Verwaltung von 3D-Druck-Filamenten. Es hilft dir dabei, den Überblick über deine Filamentspulen, Hersteller, Farben und den aktuellen Bestand zu behalten. Zudem bietet es Schnittstellen zu Druckern und AMS (Automatic Material System) Einheiten.

### 💡 Hardware-Erweiterung: FilaMan ESP32-Waage
Um das volle Potenzial dieses Systems auszuschöpfen, empfehlen wir unser zugehöriges Hardware-Projekt:
**[FilaMan-System-ESP32](https://github.com/Fire-Devils/FilaMan-System-ESP32)**
Mit dieser ESP32-basierten smarten Waage samt RFID-Integration kannst du deine Spulen auflegen, das Restgewicht automatisch messen und die Daten via RFID-Tag direkt mit dieser Software synchronisieren!

### 🏠 Home Assistant Integration
Für Nutzer von Home Assistant gibt es ein extrem praktisches Add-on:
**[ha-filaman-system](https://github.com/netscout2001/ha-filaman-system)**
Damit lässt sich das FilaMan System mit wenigen Klicks direkt in deiner Home Assistant Umgebung installieren und betreiben.

## Features
- **Spulen-Verwaltung:** Tracking von Restgewicht, Lagerort und Status.
- **Mandantenfähigkeit:** Multi-User-Unterstützung mit Rollensystem.
- **Drucker-Integration:** Plugin-System zur Anbindung von 3D-Druckern und AMS-Einheiten.
- **Datenbank-Support:** Kompatibel mit SQLite (Standard), MySQL und PostgreSQL.
- **Responsive UI:** Modernes Design (Hell, Dunkel und Brand-Theme).

## 🗺️ Roadmap
Wir haben spannende Pläne für die Zukunft von FilaMan:
- **Drucker-Plugins:** Entwicklung von Plugins für die Verbindung zu verschiedenen 3D-Druckern (Beiträge durch die Community sind sehr willkommen!).
- **Mobile Apps:** Native Apps für iOS und Android.
- **Spulen-Labels:** Generieren und Drucken von Etiketten/Labels für Spulen.
- **OIDC (OAuth2) Login:** Unterstützung für Single Sign-On (SSO) via OpenID Connect.

## Installation

### Schnellstart (Docker)
Der einfachste Weg, FilaMan zu starten, ist über Docker:

```bash
docker run -d \
  --name filaman-system-app \
  --restart unless-stopped \
  --pull always \
  -p 8083:8000 \
  -v filaman_data:/app/data \
  ghcr.io/fire-devils/filaman-system:latest
```

Die Anwendung ist anschließend unter `http://localhost:8083` erreichbar.
- **Standard E-Mail:** `admin@example.com`
- **Standard Passwort:** `admin123`

### Docker Container selber bauen

#### Voraussetzungen
- Docker
- Docker Buildx mit Multi-Architektur-Unterstützung (für ARM/AMD)

#### Build & Ausführen
```bash
git clone https://github.com/Fire-Devils/filaman-system.git && cd filaman-system

# Image bauen
docker build -t filaman-system:latest .

# Oder mit docker-compose
docker-compose up --build

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

## Lokale Entwicklung

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
Das Backend ist unter `http://localhost:8000` verfügbar.

#### Frontend starten
```bash
cd frontend
npm install
npm run dev
```
Das Frontend ist unter `http://localhost:4321` verfügbar.

#### Frontend für Produktion bauen
```bash
cd frontend
npm run build
```
Die statischen Dateien liegen in `frontend/dist/`.

## Konfiguration (Umgebungsvariablen)
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

## Projektstruktur

```text
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

## Technologie

**Backend:**
- FastAPI
- SQLAlchemy 2.0 + Alembic
- Python 3.11+

**Frontend:**
- Astro + Tailwind CSS
- Statischer Build

## Lizenz
MIT