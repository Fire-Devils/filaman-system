# 03 – Domain: External Devices (DB Schema)

Status: final  
Version: v1  
Last Updated: 2026-02-13  

---

## 1) Zweck und Scope

Dieses Dokument spezifiziert das Datenbankschema fuer externe Devices, die mit der API kommunizieren:
- z.B. Waage mit RFID, RFID Reader, Location Scanner
- Auth per Device Token
- Scopes (Permissions) pro Device (JSON)
- Soft Delete fuer Devices

Nicht Teil dieses Dokuments
- Users/RBAC Tabellen (siehe 02)
- Filament/Spool Tabellen (siehe 01)
- Drucker/AMS Tabellen (siehe 04/05)
- REST API Details (siehe 17_api_resources_5_devices.md und spool-measurements endpoint)

---

## 2) Abhaengigkeiten

- Depends on:
  - 02_domain_users_rbac_db.md (permissions keys als scopes)
- Referenziert von:
  - 01_domain_filaments_db.md:
    - spool_events.device_id -> devices.id

---

## 3) Entscheidungen (Decisions)

- Devices sind eigene Principals (nicht an User gebunden)
- Genau ein Token pro Device (T1)
- Device Scopes:
  - devices.scopes JSON
  - scopes NULL => kein Zugriff (secure default, D1)
- Tokenformat:
  - dev.<device_id>.<secret> (Klartext nur bei Create/Rotate)
- Soft Delete:
  - devices.deleted_at setzen, is_active=false
- Audit:
  - spool_events koennen device_id setzen (user_id NULL)

---

## 4) Tabellen

### 4.1 devices
Felder
- id (PK)
- name (TEXT, NOT NULL)
- device_type (TEXT, NOT NULL) (scale, rfid_reader, location_scanner, generic)
- description (TEXT, NULL)

- token_hash (TEXT, NOT NULL)
  - Hash vom secret Anteil des Device Tokens

- scopes (JSON, NULL)
  - NULL => kein Zugriff
  - gesetzt => Array von permission keys

- last_used_at (datetime, NULL)
- is_active (BOOL, default true)
- deleted_at (datetime, NULL)

- custom_fields (JSON, NULL)
- created_at
- updated_at

Indizes/Constraints
- optional UNIQUE(name)
- INDEX(device_type)
- INDEX(is_active)
- INDEX(deleted_at)

Tokenformat (Spez)
- dev.<id>.<secret>

---

## 5) Business Rules / Policies (Referenz)

- Auth:
  - scopes NULL => deny
  - sonst permission in scopes erforderlich
- Soft delete:
  - deleted_at setzen, is_active=false
- last_used_at:
  - bei jedem gueltigen Request aktualisieren

Details: siehe 08_backend_auth_full.md und 17_api_resources_5_devices.md

---

## 6) Security Notes

- token_hash muss mit starkem Hash gespeichert werden (Argon2id/bcrypt)
- Klartext Device Tokens nur einmal ausgeben (Create/Rotate)
- Keine Tokens in Logs

---

## 7) Akzeptanzkriterien

- Device kann angelegt werden, token_hash gespeichert
- scopes NULL fuehrt zu "kein Zugriff" (secure default)
- Soft delete deaktiviert device
- spool_events kann device_id referenzieren

---