# 31 – Implementation Checklist (v1)

Status: final  
Version: v1  
Last Updated: 2026-02-13  

---

## Phase 0 – Setup
- [ ] Repo Struktur: backend/ und frontend/
- [ ] Python Projekt setup (pyproject/requirements)
- [ ] Frontend Astro Projekt setup (Tailwind integriert)
- [ ] Basis README mit lokalen Startkommandos

## Phase 1 – DB + Migrationen
- [ ] SQLAlchemy Base + DB Session Dependency
- [ ] Alembic initialisiert
- [ ] Modelle: manufacturers
- [ ] Modelle: filaments (inkl. diameter_mm, material_subgroup, finish_type, manufacturer_color_name)
- [ ] Modelle: colors
- [ ] Modelle: filament_colors
- [ ] Modelle: filament_printer_profiles
- [ ] Modelle: locations
- [ ] Modelle: spool_statuses
- [ ] Modelle: spools (inkl. deleted_at, rfid_uid UNIQUE, external_id UNIQUE, purchase_price, dimensions, low_weight_threshold_g)
- [ ] Modelle: spool_events (inkl. user_id, device_id, meta.adjustment_type support)
- [ ] Modelle: filament_ratings
- [ ] Modelle: users (inkl. language, deleted_at, is_superadmin)
- [ ] Modelle: oauth_identities
- [ ] Modelle: roles, permissions
- [ ] Modelle: user_roles, role_permissions, user_permissions (optional)
- [ ] Modelle: user_api_keys
- [ ] Modelle: devices
- [ ] Modelle: user_sessions
- [ ] Modelle: printers
- [ ] Modelle: printer_ams_units
- [ ] Modelle: printer_slots
- [ ] Modelle: printer_slot_assignments
- [ ] Modelle: printer_slot_events
- [ ] Alembic Migration erzeugt und laeuft (SQLite)

## Phase 2 – Seeds / Bootstrap
- [ ] Seed spool_statuses defaults (idempotent)
- [ ] Seed permissions (vollstaendige Liste, idempotent)
- [ ] Seed roles: viewer/user/admin (idempotent)
- [ ] Seed role_permissions mapping (viewer/user/admin)
- [ ] ENV Bootstrap Admin User (ADMIN_EMAIL, ADMIN_PASSWORD) – P0 (kein overwrite)
- [ ] Erste Smoke: DB startet, seeds laufen ohne Duplikate

## Phase 3 – Auth, CSRF, RBAC Core
- [ ] Hashing Utils (Argon2id/bcrypt)
- [ ] Tokenformat implementiert:
  - [ ] ApiKey uak.<id>.<secret>
  - [ ] Device dev.<id>.<secret>
  - [ ] Session sess.<id>.<secret>
- [ ] AuthMiddleware (Session > ApiKey > Device)
- [ ] CsrfMiddleware (C1: /api/v1 mutating + /auth/logout, nur session)
- [ ] require_auth Dependency
- [ ] require_permission Dependency (RBAC + scopes)
- [ ] Superadmin short-circuit
- [ ] /auth/login setzt session_id cookie + csrf_token cookie
- [ ] /auth/logout revokes session + clears cookies
- [ ] /auth/me liefert user summary

## Phase 4 – Core Services (Business Logik)
- [ ] SpoolService: create/update/soft delete
- [ ] SpoolService: record measurement (by spool_id)
- [ ] SpoolService: record measurement by identifier (rfid/external)
- [ ] SpoolService: record adjustment (relative/absolute)
- [ ] SpoolService: record consumption
- [ ] SpoolService: status events (opened/drying/empty/archive)
- [ ] SpoolService: move location
- [ ] D2 (T2): tara missing -> store event only, remaining nicht setzen
- [ ] REL (R0): relative event ohne anchor -> store event only
- [ ] D3 (N2+E1): clamp to 0 + auto-empty event/status
- [ ] rebuild_spool_remaining_weight:
  - [ ] tara missing -> remaining NULL + system warning event
  - [ ] result 0 -> set empty + empty event meta.source=rebuild
- [ ] AMS Slots Service:
  - [ ] upsert ams units
  - [ ] upsert slots
  - [ ] assignments update
  - [ ] slot events insert
  - [ ] Policy K: spool_removed clears identifiers

## Phase 5 – REST API Router (v1)
- [ ] /api/v1/me GET/PATCH
- [ ] /api/v1/me/change-password POST
- [ ] Manufacturers CRUD
- [ ] Colors CRUD
- [ ] Filaments CRUD
- [ ] Filaments colors replace PUT
- [ ] Filament printer profiles CRUD (unter filaments)
- [ ] Spools CRUD (DELETE soft)
- [ ] Spool events endpoints (Design B)
- [ ] Device measurement by identifier POST /spool-measurements
- [ ] Locations CRUD (DELETE restrict)
- [ ] Printers CRUD (DELETE cascade AMS/slots, restrict filament_printer_profiles)
- [ ] AMS/Slots Read Endpoints
- [ ] Devices Admin API (create/rotate/soft delete)
- [ ] User API Keys self-service (create/rotate/delete/list)
- [ ] Ratings (list + me upsert + delete + optional summary)
- [ ] Admin API:
  - [ ] users CRUD + reset password + roles replace + permissions replace
  - [ ] roles CRUD + set permissions replace
  - [ ] permissions CRUD
- [ ] OpenAPI Docs erreichbar (FastAPI swagger)

## Phase 6 – Plugin Runtime
- [ ] Plugin Loader (plugins.<driver_key>.driver: Driver)
- [ ] Plugin Manager startet alle aktiven printers beim startup
- [ ] Plugin stop beim shutdown
- [ ] EventEmitter: emit(event_dict) -> core handler
- [ ] Core handler validiert und persistiert via AMS Slots Service
- [ ] Dummy Plugin vorhanden zum Test

## Phase 7 – Logging + Health
- [ ] JSON Logging konfiguriert (LOG_LEVEL)
- [ ] request_id middleware (correlation id)
- [ ] /health (liveness)
- [ ] /health/ready (db + plugin runtime)
- [ ] optional /api/v1/admin/health/plugins

## Phase 8 – Frontend (Astro + Tailwind)
- [ ] Layout: Sidebar collapsible (icons/text)
- [ ] Login page (POST /auth/login)
- [ ] API client:
  - [ ] credentials include
  - [ ] CSRF header injection
  - [ ] error handling 401/403/409/422
- [ ] /dashboard (low spools, unknown ams)
- [ ] Filaments pages (list/new/detail)
- [ ] Spools pages (list/new/detail + events/forms)
- [ ] Locations pages
- [ ] Settings page (language + change password + theme local)
- [ ] Admin pages:
  - [ ] users
  - [ ] roles
  - [ ] permissions
  - [ ] devices (token reveal)
  - [ ] printers + AMS view
- [ ] Permission gating via GET /api/v1/me

## Phase 9 – Tests (minimal)
- [ ] Backend tests: auth middleware + csrf
- [ ] Backend tests: spool measurement policies (tara missing, clamp, auto-empty)
- [ ] Backend tests: ams slot apply events
- [ ] Smoke test script (manual checklist)

---