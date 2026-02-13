# 30 – Master Agent Prompt (v1)

Status: final  
Version: v1  
Last Updated: 2026-02-13  

---

## 1) Zweck und Scope

Dieses Dokument ist eine copy-paste Master-Prompt Vorlage fuer einen Coding-Agent.
Es enthaelt Zielsystem, Tech-Stack, Policies, Reihenfolge und Definition of Done.

---

## 2) Master Agent Prompt (copy/paste)

Du bist ein Coding-Agent. Implementiere das Projekt wie unten spezifiziert. Arbeite iterativ in klaren Schritten.  
Nach jedem Schritt: liefere eine kurze Zusammenfassung, welche Files erstellt/geaendert wurden und wie man es testet.

Wichtige Rahmenbedingungen
- Sprache in Code/Kommentare: Englisch (empfohlen), UI Texte koennen spaeter i18n bekommen
- Keine Dockerisierung in dieser Phase
- Datenbank: SQLite als Default, aber DATABASE_URL muss auch Postgres/MySQL erlauben
- Security: Keine Secrets im Klartext loggen
- Tokens im Format:
  - ApiKey: uak.<id>.<secret>
  - Device: dev.<id>.<secret>
  - Session cookie: sess.<id>.<secret>

---

### 0) Zielsystem Kurzbeschreibung

Baue ein Filamentverwaltungssystem fuer 3D Druck:
- Backend: FastAPI, SQLAlchemy 2.0, Alembic
- Auth:
  - UI Session Cookie + CSRF (Double Submit Cookie) fuer mutating /api/v1/*
  - PAT ApiKeys fuer Tools
  - Device Tokens fuer Waage/RFID (Device-only Events)
  - /api/v1 akzeptiert Session ODER ApiKey ODER Device (Prioritaet: Session > ApiKey > Device)
- RBAC:
  - roles, permissions, mappings
  - Admin API fuer users/roles/permissions
- Filamentverwaltung:
  - Hersteller, Filamente, Farben, Filamentfarben
  - Spulen, Status, Events, remaining_weight_g Cache + Policies
- Drucker/AMS:
  - Printer CRUD
  - Plugin Runtime: lokale Python Plugins unter plugins/
  - Plugins senden nur Filament/AMS Events; Core persistiert AMS Slot Tabellen
- Frontend:
  - Astro + Tailwind, Static Build
  - Hybrid (MPA technisch), Data Fetch im Browser via /api/v1
  - Sidebar collapsible (icons-only / expanded)
  - Admin Bereich inkl. Printers/AMS
- Logging:
  - python logging + JSON formatter
  - request_id correlation
- Health:
  - /health, /health/ready

---

### 1) Repo Struktur

Erstelle zwei Top-Level Bereiche:
- backend/  (FastAPI app)
- frontend/ (Astro static)

Backend Domain-based Struktur (Beispiel, anpassen ok):
- backend/app/main.py
- backend/app/core/...
- backend/app/modules/...
- backend/app/plugins/...

Frontend:
- frontend/src/pages/...

---

### 2) Datenbank und Migrationen

Implementiere SQLAlchemy Modelle fuer:

Filamentverwaltung:
- manufacturers
- filaments (inkl. diameter_mm, material_subgroup, finish_type, manufacturer_color_name)
- colors
- filament_colors
- locations
- spool_statuses
- spools (inkl. deleted_at, purchase_price, dimensions, low_weight_threshold_g, identifiers)
- spool_events (inkl. user_id, device_id, meta.adjustment_type support)
- filament_printer_profiles
- filament_ratings

User/RBAC/Auth:
- users (inkl. language, deleted_at, is_superadmin)
- oauth_identities
- roles
- permissions
- user_roles
- role_permissions
- user_permissions (optional, empfohlen)
- user_api_keys
- devices
- user_sessions

Printers/AMS Persistenz:
- printers
- printer_ams_units
- printer_slots
- printer_slot_assignments
- printer_slot_events

Alembic:
- Initial migration fuer alle Tabellen

---

### 3) Seeds / Bootstrap (idempotent)

Seed beim App-Startup:
- spool_statuses defaults: new/opened/drying/active/empty/archived
- permissions: vollstaendige Liste (aus Spec 27)
- roles: viewer/user/admin
- role_permissions mapping (Spec 28)
- initialer Admin via ENV:
  - ADMIN_EMAIL, ADMIN_PASSWORD
  - P0: wenn user existiert, kein overwrite

Systemobjekte Policy
- is_system=true: editierbar, nicht loeschbar

---

### 4) Auth/CSRF/RBAC Core

Implementiere:
- hashing utilities (Argon2id oder bcrypt)
- Tokenformat mit eingebauter ID:
  - uak.<id>.<secret>, dev.<id>.<secret>, sess.<id>.<secret>
- AuthMiddleware (M3)
  - setzt request.state.principal
- CsrfMiddleware (C1)
  - enforced fuer session-auth mutating /api/v1/* und POST /auth/logout
  - double submit cookie csrf_token + X-CSRF-Token header
- Permission dependency require_permission(key)
  - session: RBAC
  - apikey: RBAC intersect scopes (scopes NULL => no restriction)
  - device: scopes NULL => deny

---

### 5) REST API v1

Implementiere Endpoints gemaess Spezifikation:

Auth:
- POST /auth/login
- POST /auth/logout
- GET /auth/me

Self:
- GET /api/v1/me
- PATCH /api/v1/me
- POST /api/v1/me/change-password

Manufacturers CRUD:
- /api/v1/manufacturers

Colors CRUD:
- /api/v1/colors

Filaments CRUD + Colors replace:
- /api/v1/filaments
- PUT /api/v1/filaments/{id}/colors

Filament Printer Profiles:
- /api/v1/filaments/{id}/printer-profiles (CRUD)

Spools CRUD:
- /api/v1/spools (DELETE soft -> deleted_at)

Spool Events (Design B):
- POST /api/v1/spools/{id}/measurements
- POST /api/v1/spools/{id}/adjustments
- POST /api/v1/spools/{id}/consumptions
- POST /api/v1/spools/{id}/opened
- POST /api/v1/spools/{id}/drying
- POST /api/v1/spools/{id}/empty
- POST /api/v1/spools/{id}/archive
- POST /api/v1/spools/{id}/move
- GET  /api/v1/spools/{id}/events

Device measurement by identifier:
- POST /api/v1/spool-measurements
  - lookup by rfid_uid or external_id

Locations CRUD:
- /api/v1/locations (DELETE restrict)

Printers CRUD:
- /api/v1/printers
  - delete: cascade AMS/slots, restrict filament_printer_profiles

AMS/Slots Read:
- /api/v1/printers/{id}/ams-units
- /api/v1/printers/{id}/slots
- /api/v1/printers/{id}/slot-assignments
- /api/v1/printers/{id}/slot-assignments/with-filament
- /api/v1/printers/{id}/slot-events
- /api/v1/printers/{id}/slots/{slot_id}/events

Devices Admin:
- /api/v1/devices (CRUD + rotate-token, soft delete)
- Permission: admin:devices_manage

User Api Keys Self:
- /api/v1/me/api-keys (list/create/update/delete/rotate)
- Tokens: uak.<id>.<secret>

Ratings:
- /api/v1/filaments/{id}/ratings
- /api/v1/filaments/{id}/ratings/me (GET)
- PUT /api/v1/filaments/{id}/ratings/me (upsert)
- DELETE /api/v1/filaments/{id}/ratings/me
- optional /summary

Admin API (Option B):
- /api/v1/admin/users (CRUD, reset-password, roles replace, permissions replace)
- /api/v1/admin/roles (CRUD + set permissions replace)
- /api/v1/admin/permissions (CRUD)

---

### 6) Business Policies (muessen implementiert werden)

Tara missing (D2 T2)
- measurement/absolute adjust ohne tara:
  - event speichern
  - remaining nicht aktualisieren
  - optional meta.tara_missing=true

Relative events ohne anchor (REL R0)
- consumption/relative adjust wenn remaining NULL:
  - event speichern
  - remaining bleibt NULL

Negative remaining (D3)
- clamp remaining < 0 auf 0
- wenn remaining == 0:
  - auto empty status setzen
  - empty event mit meta.auto=true + trigger_event_id

Rebuild (B2.1/B2.2 + D3 R1)
- rebuild_spool_remaining_weight:
  - wenn tara fehlt bei anchor:
    - remaining set NULL
    - system event manual_adjust meta.source=rebuild warning tara_missing last_plausible_remaining_g
  - wenn Ergebnis 0:
    - status empty setzen + empty event meta.source=rebuild

---

### 7) Plugin Runtime (Drucker)

Implementiere:
- plugin loader: plugins.<driver_key>.driver Driver Klasse
- manager: starte alle aktiven printers beim startup, stop beim shutdown
- EventEmitter:
  - plugin ruft emitter.emit(event_dict)
  - core validiert + persisted via ams_slots service

AMS Persistenz:
- apply spool_inserted/spool_removed/unknown/ams_state
- Policy K: spool_removed cleared identifiers in printer_slot_assignments

Driver config validation:
- in plugin via Pydantic (V1)

---

### 8) Logging + Health

Logging:
- python logging + JSON formatter
- request_id middleware
- keine Tokens loggen

Health:
- GET /health
- GET /health/ready (DB check, plugin runtime up)
- optional: GET /api/v1/admin/health/plugins

---

### 9) Frontend (Astro + Tailwind, static, client fetch)

Frontend Anforderungen:
- Layout: Sidebar collapsible (icons-only / expanded)
- Pages gemaess Wireframe-Liste (Spec 23)
- Permission gating:
  - UI laedt /api/v1/me und nutzt permissions fuer Menue/Button visibility
- API client:
  - credentials include
  - X-CSRF-Token fuer mutating /api/v1 requests (cookie csrf_token lesen)
- Tokens (Device create/rotate, ApiKey create/rotate):
  - im UI in Modal anzeigen, copy, Hinweis "nur einmal sichtbar"

Static serving:
- Astro build -> dist
- Backend liefert dist aus (StaticFiles)
- Hybrid Navigation (kein Client Router)

---

### 10) Definition of Done (v1)

Backend
- Migrationen + Seeds funktionieren
- Auth (Session, ApiKey, Device) + CSRF funktionieren
- Alle API Endpoints implementiert und autorisiert
- Business Policies umgesetzt
- Plugin runtime laeuft (dummy plugin ok)
- Health endpoints ok
- JSON logs ok

Frontend
- Seiten lauffaehig
- Login/Logout ok
- CRUD Flows fuer Filaments/Spools/Locations ok
- Admin Bereiche ok
- AMS Ansicht zeigt Slot Assignments

---

### Arbeitsweise

Implementiere in dieser Reihenfolge:
1) DB + migrations
2) seeds/bootstrap
3) auth/csrf/rbac
4) core services (spools policies)
5) api routers
6) plugin runtime + ams persistence
7) logging/health
8) frontend
9) minimale tests

Nach jedem grossen Schritt:
- nenne Startanleitung (commands)
- nenne minimalen Smoke Test

---