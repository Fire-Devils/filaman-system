# 29 – Agent Task Breakdown (v1)

Status: final  
Version: v1  
Last Updated: 2026-02-13  

---

## 1) Zweck und Scope

Dieses Dokument ist die strukturierte Aufgabenliste fuer die Umsetzung von v1.
Es dient als Grundlage fuer AI Agents oder Entwickler.

---

## 2) Phasen

Phase 0 – Setup
- Repo Struktur, tooling

Phase 1 – DB + Migrationen
- Modelle, Alembic

Phase 2 – Seeds/Bootstrap
- Default Daten, Admin ENV

Phase 3 – Security Core
- Tokenformat, AuthMiddleware, CSRF, Permissions

Phase 4 – REST API
- Ressourcen 1..7 + Admin

Phase 5 – Plugin Runtime + AMS Persistenz
- loader/manager/emitter, apply events

Phase 6 – Logging + Health
- JSON logs, /health, /ready

Phase 7 – Frontend
- Astro pages, api client, permission gating, i18n

Phase 8 – Tests
- minimal tests

---

## 3) Definition of Done (v1)
- Alle Phasen abgeschlossen, Smoke tests ok
- Keine Dockerisierung hier (kommt spaeter)

---