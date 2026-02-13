# 14 – REST API (v1) – Ressourcen 2: Spools und Spool Events (Design B)

Status: final  
Version: v1  
Last Updated: 2026-02-13  

---

## 1) Zweck und Scope

Dieses Dokument spezifiziert:
- Spools CRUD (DELETE = Soft Delete)
- Spool Events als dedizierte Endpoints (Design B)
- Device Measurement by Identifier Endpoint

Nicht Teil
- Locations (15)
- Printers/AMS (16)
- Devices Admin (17)
- User API Keys (18)
- Ratings (19)

---

## 2) Abhaengigkeiten

- 12_api_core_conventions.md
- 01_domain_filaments_db.md (spools, spool_events, policies)
- 09_backend_service_policies.md (D2, D3, REL)

---

## 3) Spools CRUD

GET /api/v1/spools
- Permission: spools:read
- Default: deleted_at IS NULL
- Query:
  - include_deleted (bool, default false)
  - filament_id, status_id, location_id, lot_number
  - remaining_weight_g__lt/__gt/__lte/__gte

GET /api/v1/spools/{spool_id}
- Permission: spools:read

POST /api/v1/spools
- Permission: spools:create

PATCH /api/v1/spools/{spool_id}
- Permission: spools:update

DELETE /api/v1/spools/{spool_id}
- Permission: spools:delete
- Policy SD2: Soft Delete
  - set spools.deleted_at = now()
  - optional: status -> archived (policy optional)

Devices
- duerfen keine Spools pflegen (nur Events)

---

## 4) Spool Events (Design B)

GET /api/v1/spools/{spool_id}/events
- Permission: spools:read oder spool_events:read
- Filter: event_type, event_at__gte, event_at__lte

Write Endpoints

POST /api/v1/spools/{spool_id}/measurements
- Permission:
  - User: spools:adjust_weight oder spool_events:create_measurement
  - Device: spool_events:create_measurement (scope)
- Body: event_at, measured_weight_g (Brutto), note, meta
- Policies: D2 T2, D3 clamp+auto-empty

POST /api/v1/spools/{spool_id}/adjustments
- Permission:
  - User: spools:adjust_weight oder spool_events:create_adjustment
- Body:
  - adjustment_type relative|absolute
  - delta_weight_g oder measured_weight_g (Brutto)
- Policies: D2, REL, D3

POST /api/v1/spools/{spool_id}/consumptions
- Permission: spools:update oder spool_events:create_consumption
- Body: event_at, delta_weight_g (negativ), meta, note
- Policies: REL, D3

POST /api/v1/spools/{spool_id}/opened
POST /api/v1/spools/{spool_id}/drying
POST /api/v1/spools/{spool_id}/empty
POST /api/v1/spools/{spool_id}/archive
- Permission: spools:update (archive: spools:archive)
- drying meta: temperature_c, duration_h

POST /api/v1/spools/{spool_id}/move
- Permission: spools:move_location oder spool_events:create_move_location
- Body: event_at, to_location_id, note, meta

Audit
- User Requests: spool_events.user_id gesetzt
- Device Requests: spool_events.device_id gesetzt

---

## 5) Device Endpoint: Measurement by Identifier

POST /api/v1/spool-measurements
- Auth: Device token
- Permission: spool_events:create_measurement (Device scope)
- Body:
  - event_at
  - measured_weight_g
  - rfid_uid oder external_id (mindestens eins)
  - note, meta
- Behavior:
  - lookup spool by identifiers
  - if not found: 404 spool_not_found
  - write measurement event + update remaining per policies

---

## 6) Errors

- 401 unauthorized
- 403 forbidden (missing permission/scope, device scopes NULL)
- 404 spool_not_found (identifier lookup)
- 409 conflict (unique rfid/external violations)
- 422 validation_error

---

## 7) Akzeptanzkriterien

- Spools soft delete funktioniert (deleted_at)
- Event endpoints erzeugen spool_events und aktualisieren remaining nach policies
- Device measurement by identifier funktioniert
- Audit user_id/device_id wird korrekt gesetzt

---