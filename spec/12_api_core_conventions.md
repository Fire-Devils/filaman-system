# 12 – REST API (v1) – Grundkonventionen

Status: final  
Version: v1  
Last Updated: 2026-02-13  

---

## 1) Zweck und Scope

Dieses Dokument definiert die allgemeinen Regeln der REST API:
- Basis-Pfad, Versionierung
- Content Types
- Response Formen
- Pagination, Sorting, Filtering
- Fehlerformat
- Auth Header (Referenz)
- Idempotency (optional)

Nicht Teil dieses Dokuments
- Konkrete Endpoints (siehe 13+)
- DB Schema (siehe 01-05)

---

## 2) Versionierung und Base Path
- Base: /api/v1
- Breaking changes -> /api/v2

---

## 3) Content Types
- Requests: Content-Type application/json (wenn Body)
- Responses: application/json

---

## 4) Standard Responses

Einzelobjekt
- Response ist das Objekt

Listen
    {
      "items": [...],
      "page": 1,
      "page_size": 50,
      "total": 123
    }

---

## 5) Pagination
- page (default 1)
- page_size (default 50, max 200)

---

## 6) Sorting
- sort=field (asc)
- sort=-field (desc)

---

## 7) Filtering
- field=value
- Operatoren:
  - field__lt, field__lte, field__gt, field__gte, field__in

Beispiel
- /spools?remaining_weight_g__lt=100
- /filaments?type=PLA&diameter_mm=1.75

---

## 8) Fehlerformat

    {
      "error": {
        "code": "validation_error",
        "message": "Human readable summary",
        "details": {}
      }
    }

Typische Codes
- validation_error
- unauthorized
- forbidden
- not_found
- conflict
- csrf_failed
- concurrent_update (optional)

---

## 9) Auth (Referenz)

- Authorization: ApiKey uak.<id>.<secret>
- Authorization: Device dev.<id>.<secret>
- Session Cookie (UI): session_id=sess.<id>.<secret>

CSRF
- Double submit cookie csrf_token + X-CSRF-Token fuer session-auth mutating /api/v1

---

## 10) Idempotency (optional v1)

Optionaler Header
- Idempotency-Key: <uuid>

v1 Status
- nicht implementiert (bewusst ignoriert)

---

## 11) Akzeptanzkriterien

- API liefert Listen im standard format
- Fehlerantworten folgen ErrorResponse
- Pagination/sort/filter Query Parameter sind konsistent

---