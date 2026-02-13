# 17 – REST API (v1) – Ressourcen 5: Devices (Admin)

Status: final  
Version: v1  
Last Updated: 2026-02-13  

---

## 1) Zweck und Scope

Dieses Dokument spezifiziert:
- Admin Verwaltung von Devices
- Token Create/Rotate (Token nur einmal anzeigen)
- Soft Delete von Devices
- Optional: device self endpoint

Nicht Teil
- Device measurement endpoint (siehe 14)
- Auth details (siehe 08)

---

## 2) Abhaengigkeiten

- 12_api_core_conventions.md
- 03_domain_devices_db.md

---

## 3) Permissions

Admin only
- admin:devices_manage

---

## 4) Endpoints

GET /api/v1/devices
- Permission: admin:devices_manage

GET /api/v1/devices/{device_id}
- Permission: admin:devices_manage

POST /api/v1/devices
- Permission: admin:devices_manage
- Response: device + token (Klartext) im Format dev.<id>.<secret>

PATCH /api/v1/devices/{device_id}
- Permission: admin:devices_manage

POST /api/v1/devices/{device_id}/rotate-token
- Permission: admin:devices_manage
- Response: token (Klartext) im Format dev.<id>.<secret>

DELETE /api/v1/devices/{device_id}
- Permission: admin:devices_manage
- Soft Delete:
  - deleted_at=now
  - is_active=false

Optional
GET /api/v1/device/me
- Auth: Device token
- Response: device summary (ohne token_hash)

---

## 5) Akzeptanzkriterien

- Device Create liefert Token einmalig
- Rotate Token ueberschreibt token_hash und liefert neuen Token
- Soft delete deaktiviert device
- scopes NULL => kein Zugriff (secure default)

---