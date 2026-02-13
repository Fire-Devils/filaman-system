# 02 – Domain: Users, Login, OAuth, RBAC, Sessions, API Keys (DB Schema)

Status: final  
Version: v1  
Last Updated: 2026-02-13  

---

## 1) Zweck und Scope

Dieses Dokument spezifiziert das Datenbankschema fuer:
- User Accounts (lokal)
- Passwort-Login (password_hash)
- OAuth2/OIDC Linking auf lokale Accounts (oauth_identities)
- Rollen und Permissions (RBAC)
- User Sessions (UI Session Cookie)
- User API Keys (PAT) fuer Tools/Integrationen
- Multilingual pro User (users.language)
- Soft Delete fuer Users (users.deleted_at)

Nicht Teil dieses Dokuments
- Devices (siehe 03)
- Filament/Spool Tabellen (siehe 01)
- Drucker/AMS Tabellen (siehe 04/05)
- REST API Details (siehe API Specs)

---

## 2) Abhaengigkeiten

- Referenziert von:
  - 01_domain_filaments_db.md:
    - spool_events.user_id -> users.id
    - filament_ratings.user_id -> users.id
- Admin Seeds/Bootstrap (siehe 10_backend_seeds_bootstrap.md)

---

## 3) Entscheidungen (Decisions)

- Auth-Modell:
  - Lokale User sind Source of Truth
  - OAuth2/OIDC dient als Login, verknuepft auf lokale Users (Mapping)
- OAuth Mapping Regel (M1):
  - Auto-Linking nur ueber primaere, verifizierte Email
- RBAC:
  - Rollen + Permissions in DB, M:N Beziehungen
  - User kann mehrere Rollen haben
  - Optionale direkte Permissions pro User (user_permissions) ist enthalten
- Superadmin:
  - users.is_superadmin (Short-Circuit in Permission Checks)
- Soft Delete:
  - users.deleted_at (User wird nicht physisch geloescht)
- Sprache:
  - users.language (IETF language tag), default "en"
- API Keys:
  - user_api_keys mit key_hash, scopes JSON (NULL = keine Einschraenkung)
- Session Store:
  - user_sessions, Session Cookie Value Format: sess.<id>.<secret> (Tokenformat Spez in 08)

---

## 4) Tabellen

### 4.1 users
Felder
- id (PK)
- email (TEXT, NOT NULL, UNIQUE)
- email_verified (BOOL, default false)
- display_name (TEXT, NULL)

- language (TEXT, NOT NULL, default "en")  (z.B. de, en, de-DE)

- password_hash (TEXT, NULL)
  - NULL erlaubt (OAuth-only Account)

- is_active (BOOL, default true)
- is_superadmin (BOOL, default false)

- last_login_at (datetime, NULL)
- deleted_at (datetime, NULL)

- custom_fields (JSON, NULL)
- created_at
- updated_at

Indizes
- UNIQUE(email)
- optional INDEX(is_active)
- optional INDEX(language)
- optional INDEX(deleted_at)

Delete Behavior
- Soft delete (deleted_at) per Policy
- Hard delete nur in Ausnahme; siehe FK Regeln in abh. Tabellen (meist CASCADE oder SET NULL)

---

### 4.2 oauth_identities
Verknuepfung externer Identitaeten (OIDC sub) auf lokale Users.

Felder
- id (PK)
- user_id (FK -> users.id, NOT NULL, ON DELETE CASCADE)
- provider (TEXT, NOT NULL) (google, github, keycloak, ...)
- provider_subject (TEXT, NOT NULL) (OIDC sub)
- provider_email (TEXT, NULL)
- provider_email_verified (BOOL, default false)

Optionale Token Speicherung (v1 optional)
- access_token_enc (TEXT, NULL)
- refresh_token_enc (TEXT, NULL)
- token_expires_at (datetime, NULL)

- created_at
- updated_at
- last_used_at (datetime, NULL)

Constraints/Indizes
- UNIQUE(provider, provider_subject)
- INDEX(user_id)
- optional INDEX(provider, provider_email)

Notes
- Auto-Linking (M1) nur mit primaerer verifizierter Email (App-Policy).

---

### 4.3 roles
Felder
- id (PK)
- key (TEXT, NOT NULL, UNIQUE) (z.B. admin)
- name (TEXT, NOT NULL)
- description (TEXT, NULL)
- is_system (BOOL, default false)
- created_at
- updated_at

Delete Policy (Systemobjekte)
- is_system=true: editierbar, nicht loeschbar (Policy Spec)

---

### 4.4 permissions
Felder
- id (PK)
- key (TEXT, NOT NULL, UNIQUE) (resource:action)
- description (TEXT, NULL)
- is_system (BOOL, default false)
- created_at
- updated_at

Delete Policy (Systemobjekte)
- is_system=true: editierbar, nicht loeschbar

---

### 4.5 user_roles
Felder
- user_id (FK -> users.id, NOT NULL, ON DELETE CASCADE)
- role_id (FK -> roles.id, NOT NULL, ON DELETE CASCADE)

Constraints/Indizes
- PRIMARY KEY(user_id, role_id)
- INDEX(role_id)

---

### 4.6 role_permissions
Felder
- role_id (FK -> roles.id, NOT NULL, ON DELETE CASCADE)
- permission_id (FK -> permissions.id, NOT NULL, ON DELETE CASCADE)

Constraints/Indizes
- PRIMARY KEY(role_id, permission_id)
- INDEX(permission_id)

---

### 4.7 user_permissions (optional, empfohlen)
Direkte Permissions pro User (Ausnahmen zusaetzlich zu Rollen).

Felder
- user_id (FK -> users.id, NOT NULL, ON DELETE CASCADE)
- permission_id (FK -> permissions.id, NOT NULL, ON DELETE CASCADE)

Constraints/Indizes
- PRIMARY KEY(user_id, permission_id)
- INDEX(permission_id)

---

### 4.8 user_api_keys
PAT fuer Tools.

Felder
- id (PK)
- user_id (FK -> users.id, NOT NULL, ON DELETE CASCADE)

- name (TEXT, NOT NULL)
- key_hash (TEXT, NOT NULL)

- scopes (JSON, NULL)
  - NULL => keine Einschraenkung (Key hat volle RBAC Rechte des Users)
  - gesetzt => intersection (nur einschraenkend)

- last_used_at (datetime, NULL)
- created_at
- updated_at

Indizes
- INDEX(user_id)
- optional UNIQUE(user_id, name)

Tokenformat (Spez)
- uak.<id>.<secret> (Klartext nur bei Create/Rotate)

---

### 4.9 user_sessions
UI Sessions fuer Cookie Auth.

Felder
- id (PK)
- user_id (FK -> users.id, NOT NULL, ON DELETE CASCADE)

- session_token_hash (TEXT, NOT NULL)

- created_at (datetime, NOT NULL)
- last_used_at (datetime, NULL)

- expires_at (datetime, NULL) (empfohlen)
- revoked_at (datetime, NULL)

Optionale Metadaten
- user_agent (TEXT, NULL)
- ip_address (TEXT, NULL)
- name (TEXT, NULL)

Indizes
- INDEX(user_id)
- INDEX(expires_at)
- INDEX(revoked_at)

Tokenformat (Spez)
- sess.<id>.<secret> (im Cookie session_id)

---

## 5) Business Rules / Policies (Referenz)

- Soft delete:
  - users.deleted_at setzen, is_active=false
- OAuth Linking:
  - nur primaere verifizierte Email fuer Auto-Linking
- Superadmin:
  - Permission check short-circuit true
- user_api_keys:
  - scopes NULL => keine Einschraenkung
- Sessions:
  - revoked_at != NULL => ungueltig
  - expires_at (falls gesetzt) in Vergangenheit => ungueltig

Details: siehe 08_backend_auth_full.md und 20_api_admin_endpoints.md

---

## 6) Security Notes

- Keine Tokens/Secrets in Logs
- Hashing (Argon2id/bcrypt) fuer:
  - password_hash
  - key_hash
  - session_token_hash
- User Hard delete vermeiden (Audit), Soft delete nutzen

---

## 7) Akzeptanzkriterien

- Migrationen erzeugen alle Tabellen und Constraints
- UNIQUE(email), UNIQUE(provider,subject), UNIQUE(role.key), UNIQUE(permission.key) funktionieren
- Soft Delete ist moeglich ohne Verlust von Audit (FKs bleiben)
- user_api_keys und user_sessions koennen Tokens im Format uak./sess. abbilden

---