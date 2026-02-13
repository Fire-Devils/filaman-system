# 00 – Projektindex: 3D-Druck Filamentverwaltungssystem

Status: final  
Version: v1  
Last Updated: 2026-02-13  

---

## 1) Zweck und Scope

Dieses Projekt definiert und implementiert ein Filamentverwaltungssystem fuer 3D-Druck.
Kernfunktionen:
- Filamente, Hersteller, Farben
- Spulenbestand inkl. Gewicht, Events (Measurement, Verbrauch, Korrektur), Lagerorte
- Druckerverwaltung mit modularer Anbindung ueber lokale Python-Plugins
- AMS/Slots Persistenz (welche Spule steckt in welchem Slot)
- User/Login (PW + OAuth2/OIDC) mit Rollen und Permissions (RBAC)
- REST API (v1) inkl. Device Tokens und User API Keys
- Frontend: Astro + Tailwind (Static Build), cookie-basierte Session

Nicht Teil (noch nicht implementiert in v1 Specs)
- Docker/Compose (kommt spaeter als eigener Block)
- Druckersteuerung (Start/Pause/Stop Jobs) ist explizit out of scope
- Komplexe Idempotency fuer Device Events (bewusst ignoriert)

---

## 2) Tech-Stack (Entscheidungen)

Backend
- FastAPI
- SQLAlchemy 2.0 + Alembic
- Domain-based Modulstruktur

Auth
- UI Session Cookie (HttpOnly) + CSRF (Double Submit Cookie)
- User API Keys (PAT) fuer Tools
- Device Tokens fuer externe Geraete (Waage/RFID)
- /api/v1 akzeptiert Session oder ApiKey oder Device Token (Prioritaet: Session > ApiKey > Device)

Frontend
- Astro + Tailwind
- Static Build
- Hybrid Routing (MPA technisch), Daten werden clientseitig per fetch geladen
- i18n: de, en (users.language)

---

## 3) System-Entscheidungen (Highlights)

Filamente/Spulen
- Custom Fields pro Entitaet via JSON `custom_fields`
- Farben normalisiert: colors + filament_colors
- Spule = physisches Objekt (ein Datensatz)
- Spule hat:
  - rfid_uid UNIQUE (wenn gesetzt)
  - external_id UNIQUE (wenn gesetzt)
  - lot_number, purchase_date, expiration_date, purchase_price
  - initial_total_weight_g (Brutto bei Ankunft)
  - remaining_weight_g als Cache + spool_events als Wahrheit

Gewicht/Events Policies
- Measurement ist Brutto (Spule+Filament)
- Tara missing (D2 T2): Event speichern, remaining nicht berechnen
- Relative events ohne Anchor (REL R0): Event speichern, remaining bleibt NULL
- Negative remaining (D3): clamp auf 0 + auto-empty + rebuild setzt empty

Drucker/Plugins
- Plugins unter plugins/ (lokale Module)
- Plugins lauschen nur auf Filament/AMS Events (kein Druckstatus, keine Steuerung)
- Persistenz: printer_ams_units, printer_slots, printer_slot_assignments, printer_slot_events
- Printer Delete: CASCADE fuer AMS/Slot Tabellen, RESTRICT fuer filament_printer_profiles

RBAC
- Rollen + Permissions in DB
- Default Rollen: viewer, user, admin
- Systemobjekte is_system=true: editierbar, nicht loeschbar

REST API
- Versionierung: /api/v1
- Pagination, sorting, filtering standardisiert
- Error format standardisiert
- Device measurement by identifier: POST /api/v1/spool-measurements

---

## 4) Spec Collection – Dateiuebersicht

### Datenmodell / DB
- 01_domain_filaments_db.md
- 02_domain_users_rbac_db.md
- 03_domain_devices_db.md
- 04_domain_printers_db.md
- 05_domain_ams_slots_db.md

### Plugins
- 06_plugins_architecture.md
- 07_plugins_driver_registry.md

### Backend Core
- 08_backend_auth_full.md
- 09_backend_service_policies.md
- 10_backend_seeds_bootstrap.md
- 11_backend_logging_health.md

### REST API
- 12_api_core_conventions.md
- 13_api_resources_1_manufacturers_filaments_colors.md
- 14_api_resources_2_spools_events.md
- 15_api_resources_3_locations.md
- 16_api_resources_4_printers_ams.md
- 17_api_resources_5_devices.md
- 18_api_resources_6_user_api_keys.md
- 19_api_resources_7_ratings.md
- 20_api_admin_endpoints.md

### OpenAPI
- 21_openapi_dto_todo.md
- 22_openapi_dto_admin_addendum.md

### Frontend
- 23_frontend_ia_wireframes.md
- 24_frontend_structure_routing.md
- 25_frontend_auth_csrf_flow.md
- 26_frontend_i18n.md

### RBAC Hilfsdokus
- 27_rbac_permissions_full_list.md
- 28_rbac_default_roles_mapping.md

### Agent Guides
- 29_agent_task_breakdown.md
- 30_agent_master_prompt.md
- 31_implementation_checklist.md

### Future
- 99_future_docker_deployment.md

---

## 5) Empfohlene Implementierungsreihenfolge (Kurz)

1. DB Modelle + Alembic Migrationen (alle Domains)
2. Seeds + Admin Bootstrap via ENV
3. Auth Middleware + CSRF + RBAC Dependencies
4. Core Services (Spools Policies, AMS Slot Apply)
5. REST API Endpoints (inkl. Admin API)
6. Plugin Runtime (Loader/Manager/Emitter)
7. Logging + Health
8. Frontend Pages + API client + Permission gating
9. Minimale Tests

---

## 6) Akzeptanzkriterien (v1, high-level)

Backend
- Alle Tabellen migrierbar, Seeds idempotent
- Auth: Session, ApiKey, Device + CSRF funktionieren
- REST API Endpoints gemaess Spec erreichbar und autorisiert
- Spool Policies (tara missing, clamp, auto-empty, rebuild) korrekt umgesetzt
- AMS Slot Persistenz aktualisiert sich durch Plugin Events
- Health endpoints liefern vernuenftige Ergebnisse
- JSON Logging aktiv, keine Secrets im Log

Frontend
- Login, Navigation, CRUD Screens, Admin Screens funktionieren
- Permission gating basierend auf /api/v1/me
- i18n de/en aktiv
- Theme lokal (default/light/dark)

---

## 7) Open Questions
None (v1 Spezifikationen finalisiert, Docker ausgenommen)

---