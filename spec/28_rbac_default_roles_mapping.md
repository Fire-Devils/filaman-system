# 28 – Default Rollen (Seeds) – Mapping zu Permissions (v1)

Status: final  
Version: v1  
Last Updated: 2026-02-13  

---

## 1) Zweck und Scope

Diese Datei definiert den Default Seed fuer:
- viewer
- user
- admin

---

## 2) viewer (read-only)

- filaments:read
- manufacturers:read
- locations:read
- spools:read
- spool_events:read
- printers:read
- ratings:read
- optional colors:read

---

## 3) user (normal usage)

Stammdaten (read)
- filaments:read
- manufacturers:read
- locations:read
- printers:read
- ratings:read

Spools
- spools:read
- spools:create
- spools:update
- spools:adjust_weight
- spools:move_location
- spools:archive
- spools:consume

Spool events
- spool_events:read
- spool_events:create_measurement
- spool_events:create_adjustment
- spool_events:create_consumption
- spool_events:create_status
- spool_events:create_move_location

Ratings
- ratings:write
- ratings:delete

User API Keys
- user_api_keys:read_own
- user_api_keys:create_own
- user_api_keys:update_own
- user_api_keys:rotate_own
- user_api_keys:delete_own

---

## 4) admin (vollzugriff)

- alle viewer + user permissions
- plus:
  - filaments:create/update/delete
  - manufacturers:create/update/delete
  - locations:create/update/delete
  - spools:delete
  - printers:create/update/delete
  - admin:users_manage
  - admin:rbac_manage
  - admin:devices_manage
  - optional colors:create/update/delete
  - optional user_api_keys:*_any (oder ueber admin:users_manage)

---