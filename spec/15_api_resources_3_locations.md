# 15 – REST API (v1) – Ressourcen 3: Locations

Status: final  
Version: v1  
Last Updated: 2026-02-13  

---

## 1) Zweck und Scope

Dieses Dokument spezifiziert CRUD Endpoints fuer Lagerorte (locations).

Delete Policy
- L1: RESTRICT wenn referenziert

---

## 2) Abhaengigkeiten

- 12_api_core_conventions.md
- 01_domain_filaments_db.md (locations, references)

---

## 3) Endpoints

GET /api/v1/locations
- Permission: locations:read

GET /api/v1/locations/{location_id}
- Permission: locations:read

POST /api/v1/locations
- Permission: locations:create

PATCH /api/v1/locations/{location_id}
- Permission: locations:update

DELETE /api/v1/locations/{location_id}
- Permission: locations:delete
- Policy L1: 409 conflict wenn referenziert durch:
  - spools.location_id
  - spool_events.from_location_id / to_location_id
  - printers.location_id (optional)

---

## 4) Akzeptanzkriterien

- CRUD funktioniert
- RESTRICT delete liefert 409 conflict mit references details

---