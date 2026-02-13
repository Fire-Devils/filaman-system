# 13 – REST API (v1) – Ressourcen 1: Manufacturers, Filaments, Colors

Status: final  
Version: v1  
Last Updated: 2026-02-13  

---

## 1) Zweck und Scope

Dieses Dokument spezifiziert die API Endpoints fuer:
- manufacturers CRUD
- colors CRUD
- filaments CRUD
- filament colors replace

Nicht Teil
- spools/events (siehe 14)
- locations (15)
- printers/ams (16)
- admin endpoints (20)

---

## 2) Abhaengigkeiten

- 12_api_core_conventions.md
- 01_domain_filaments_db.md

---

## 3) Endpoints: Manufacturers

GET /api/v1/manufacturers
- Permission: manufacturers:read

GET /api/v1/manufacturers/{manufacturer_id}
- Permission: manufacturers:read

POST /api/v1/manufacturers
- Permission: manufacturers:create

PATCH /api/v1/manufacturers/{manufacturer_id}
- Permission: manufacturers:update

DELETE /api/v1/manufacturers/{manufacturer_id}
- Permission: manufacturers:delete
- Delete Policy: RESTRICT wenn referenziert durch filaments.manufacturer_id -> 409 conflict

---

## 4) Endpoints: Colors

GET /api/v1/colors
- Permission: filaments:read (oder colors:read wenn getrennt)

GET /api/v1/colors/{color_id}
- Permission: filaments:read

POST /api/v1/colors
- Permission: filaments:create (oder colors:create)

PATCH /api/v1/colors/{color_id}
- Permission: filaments:update (oder colors:update)

DELETE /api/v1/colors/{color_id}
- Permission: filaments:delete (oder colors:delete)
- Delete Policy: RESTRICT wenn referenziert in filament_colors -> 409 conflict

---

## 5) Endpoints: Filaments

GET /api/v1/filaments
- Permission: filaments:read
- Filter: manufacturer_id, type, material_subgroup, diameter_mm, finish_type, color_mode
- Paging/sort wie 12

GET /api/v1/filaments/{filament_id}
- Permission: filaments:read
- Response enthaelt embedded colors list (position + color)

POST /api/v1/filaments
- Permission: filaments:create
- Request kann colors als Liste von {position, color_id, display_name_override} enthalten

PATCH /api/v1/filaments/{filament_id}
- Permission: filaments:update

PUT /api/v1/filaments/{filament_id}/colors
- Permission: filaments:update
- Replace colors:
  - color_mode
  - multi_color_style
  - colors list

DELETE /api/v1/filaments/{filament_id}
- Permission: filaments:delete
- Delete Policy: RESTRICT wenn referenziert durch:
  - spools.filament_id
  - filament_printer_profiles.filament_id
  -> 409 conflict

---

## 6) Errors (Beispiele)

- 422 validation_error (fehlende Pflichtfelder, falscher color_mode)
- 409 conflict bei RESTRICT deletes

---

## 7) Akzeptanzkriterien

- CRUD funktioniert gemaess Permissions
- Filament detail liefert colors
- Colors replace ersetzt filament_colors sauber
- RESTRICT deletes liefern 409

---