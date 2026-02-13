# 10 – Backend Seeds und Bootstrap (v1)

Status: final  
Version: v1  
Last Updated: 2026-02-13  

---

## 1) Zweck und Scope

Dieses Dokument beschreibt:
- Welche Default-Daten (Seeds) beim Start angelegt werden
- Idempotenz-Regeln
- Bootstrap eines initialen Admin Users ueber ENV (S1)
- Policy P0: kein Passwort-Overwrite, wenn User bereits existiert

Nicht Teil dieses Dokuments
- Alembic Migrationen (nur Tabellen)
- Admin API Details (siehe 20)

---

## 2) Abhaengigkeiten

- 01_domain_filaments_db.md (spool_statuses)
- 02_domain_users_rbac_db.md (roles, permissions, mappings)
- 27_rbac_permissions_full_list.md
- 28_rbac_default_roles_mapping.md
- 09_backend_service_policies.md (policies, nur als Kontext)

---

## 3) Entscheidungen (Decisions)

- Seeds laufen im App-Startup (oder init step), idempotent
- Admin Bootstrap ueber ENV (S1)
- P0: Admin Passwort wird nie ueberschrieben, wenn User existiert
- Systemobjekte (is_system=true) sind editierbar, aber nicht loeschbar (Policy)

---

## 4) ENV Bootstrap (S1)

ENV Variablen
- ADMIN_EMAIL
- ADMIN_PASSWORD
- ADMIN_DISPLAY_NAME (optional)
- ADMIN_LANGUAGE (optional, default en)
- ADMIN_SUPERADMIN (optional, default true)

Semantik
- Wenn kein User mit ADMIN_EMAIL existiert:
  - User anlegen (password_hash setzen)
  - Rolle admin zuweisen
  - optional is_superadmin=true (empfohlen)
- Wenn User existiert:
  - nichts ueberschreiben (P0)

---

## 5) spool_statuses Seeds

Default Status (is_system=true)
- new
- opened
- drying
- active
- empty
- archived

Idempotenz
- match by spool_statuses.key

---

## 6) Permissions Seeds

- Seede alle Permission Keys aus 27_rbac_permissions_full_list.md
- is_system=true

Idempotenz
- match by permissions.key

---

## 7) Roles Seeds

Default Rollen (is_system=true)
- viewer
- user
- admin

Idempotenz
- match by roles.key

---

## 8) role_permissions Seeds

Mapping gem. 28_rbac_default_roles_mapping.md

Idempotenz
- match by (role_id, permission_id)
- implementiere als "replace missing" (insert only) oder "replace exact" (sync)
  Empfehlung v1: insert missing, nicht loeschen (sicherer)

---

## 9) Technische Umsetzung (Empfehlung)

- Alembic Migrationen erstellen nur Tabellen
- Seed Manager wird im Backend beim Startup ausgefuehrt:
  - seed_spool_statuses(db)
  - seed_permissions(db)
  - seed_roles(db)
  - seed_role_permissions(db)
  - seed_admin_user_from_env(db)

---

## 10) Akzeptanzkriterien

- Seeds sind idempotent (mehrfacher Start ohne Duplikate)
- Default Rollen/Permissions existieren
- Admin User wird beim ersten Start angelegt, kein overwrite beim zweiten Start
- spool_statuses existieren und sind referenzierbar

---