# 19 – REST API (v1) – Ressourcen 7: Filament Ratings

Status: final  
Version: v1  
Last Updated: 2026-02-13  

---

## 1) Zweck und Scope

Dieses Dokument spezifiziert Endpoints fuer Filament-Bewertungen:
- Pro User und Filament genau eine Bewertung (R1)
- Upsert ueber PUT

---

## 2) Abhaengigkeiten

- 12_api_core_conventions.md
- 01_domain_filaments_db.md (filament_ratings)

---

## 3) Permissions

- ratings:read
- ratings:write
- ratings:delete

---

## 4) Endpoints

GET /api/v1/filaments/{filament_id}/ratings
- Permission: ratings:read (oder filaments:read)
- Paging/sort

GET /api/v1/filaments/{filament_id}/ratings/me
- Permission: ratings:read
- 404 wenn nicht existiert

PUT /api/v1/filaments/{filament_id}/ratings/me
- Permission: ratings:write
- Upsert (create oder update)

DELETE /api/v1/filaments/{filament_id}/ratings/me
- Permission: ratings:delete

Optional
GET /api/v1/filaments/{filament_id}/ratings/summary
- Permission: ratings:read

---

## 5) Akzeptanzkriterien

- Pro user+filament nur ein rating (UNIQUE)
- Upsert funktioniert
- Permissions werden enforced

---