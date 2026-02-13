# 27 – RBAC Permission Keys (v1) – Vollstaendige Liste

Status: final  
Version: v1  
Last Updated: 2026-02-13  

---

## 1) Zweck und Scope

Diese Datei listet alle Permission Keys, die in v1 genutzt/geseded werden.

Format
- resource:action

---

## 2) Filamente und Stammdaten

Filamente
- filaments:read
- filaments:create
- filaments:update
- filaments:delete

Hersteller
- manufacturers:read
- manufacturers:create
- manufacturers:update
- manufacturers:delete

Colors (optional getrennt)
- colors:read
- colors:create
- colors:update
- colors:delete

---

## 3) Spulen und Lager

Spools
- spools:read
- spools:create
- spools:update
- spools:delete
- spools:adjust_weight
- spools:archive
- spools:move_location
- spools:consume

Spool Events (feingranular)
- spool_events:read
- spool_events:create_measurement
- spool_events:create_adjustment
- spool_events:create_consumption
- spool_events:create_status
- spool_events:create_move_location

Locations
- locations:read
- locations:create
- locations:update
- locations:delete

---

## 4) Drucker und AMS

Printers
- printers:read
- printers:create
- printers:update
- printers:delete

Optional (spaeter)
- printer_slot_events:read
- printer_slot_events:ingest

---

## 5) Ratings

- ratings:read
- ratings:write
- ratings:delete

---

## 6) User API Keys (Self)

- user_api_keys:read_own
- user_api_keys:create_own
- user_api_keys:update_own
- user_api_keys:rotate_own
- user_api_keys:delete_own

Optional Admin-any
- user_api_keys:read_any
- user_api_keys:rotate_any
- user_api_keys:delete_any

---

## 7) Admin

- admin:users_manage
- admin:rbac_manage
- admin:devices_manage

---

## 8) Orders (nur wenn implementiert)

- orders:read
- orders:create
- orders:update
- orders:delete

---