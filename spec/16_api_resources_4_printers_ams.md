# 16 – REST API (v1) – Ressourcen 4: Printers und AMS/Slots

Status: final  
Version: v1  
Last Updated: 2026-02-13  

---

## 1) Zweck und Scope

Dieses Dokument spezifiziert:
- Printer CRUD
- Read Endpoints fuer AMS Units, Slots, Assignments, Slot Events

Wichtig
- AMS/Slot Daten werden primaer durch Plugins geschrieben (intern), API ist v1 read-only fuer diese Strukturen.

Delete Policy Printers
- Hard delete
- CASCADE fuer AMS/Slot Tabellen
- RESTRICT wenn filament_printer_profiles existieren

---

## 2) Abhaengigkeiten

- 12_api_core_conventions.md
- 04_domain_printers_db.md
- 05_domain_ams_slots_db.md
- 01_domain_filaments_db.md (filament_printer_profiles restrict)

---

## 3) Printer CRUD

GET /api/v1/printers
- Permission: printers:read

GET /api/v1/printers/{printer_id}
- Permission: printers:read

POST /api/v1/printers
- Permission: printers:create

PATCH /api/v1/printers/{printer_id}
- Permission: printers:update

DELETE /api/v1/printers/{printer_id}
- Permission: printers:delete
- CASCADE:
  - printer_ams_units
  - printer_slots
  - printer_slot_assignments
  - printer_slot_events
- RESTRICT:
  - filament_printer_profiles (-> 409 conflict)

---

## 4) AMS Units Read

GET /api/v1/printers/{printer_id}/ams-units
- Permission: printers:read

GET /api/v1/printers/{printer_id}/ams-units/{ams_unit_id}
- Permission: printers:read

---

## 5) Slots Read

GET /api/v1/printers/{printer_id}/slots
- Permission: printers:read
- Query optional:
  - is_ams_slot
  - ams_unit_no
  - present

GET /api/v1/printers/{printer_id}/slots/{slot_id}
- Permission: printers:read

---

## 6) Slot Assignments Read

GET /api/v1/printers/{printer_id}/slot-assignments
- Permission: printers:read
- Query optional:
  - present=true|false
  - unknown=true (present=true AND spool_id IS NULL)

GET /api/v1/printers/{printer_id}/slot-assignments/with-filament
- Permission: printers:read
- Response erweitert:
  - spool (wenn mapped)
  - filament (indirekt)

---

## 7) Slot Events Read

GET /api/v1/printers/{printer_id}/slot-events
- Permission: printers:read
- Filter:
  - event_type
  - slot_id
  - spool_id
  - event_at__gte/__lte

GET /api/v1/printers/{printer_id}/slots/{slot_id}/events
- Permission: printers:read

---

## 8) Akzeptanzkriterien

- Printer CRUD funktioniert mit CASCADE/RESTRICT Verhalten
- AMS/Slots Read liefert aktuellen Zustand + Historie
- Unknown spool in assignment ist abfragbar (unknown=true)

---