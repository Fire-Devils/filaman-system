# 08 – Backend Auth (v1) – Session, ApiKey, Device, CSRF, RBAC (vollstaendig)

Status: final  
Version: v1  
Last Updated: 2026-02-13  

---

## 1) Zweck und Scope

Dieses Dokument spezifiziert das komplette Auth- und Autorisierungssystem im Backend:
- Authentifizierung:
  - UI Session Cookie
  - User API Keys (PAT)
  - Device Tokens
- Tokenformat (Lookup-per-ID)
- RBAC Permission Checks + Scopes
- CSRF Schutz fuer Session-auth mutating Requests (C1)
- Auth Endpoints (/auth/*) und Self-Service (/api/v1/me)

Nicht Teil dieses Dokuments
- DB Tabellen im Detail (siehe 02 und 03)
- REST API Ressourcen (siehe API Specs)
- Frontend Implementierung (siehe 25)

---

## 2) Abhaengigkeiten

- 02_domain_users_rbac_db.md
- 03_domain_devices_db.md
- 12_api_core_conventions.md (error format)

---

## 3) Entscheidungen (Decisions)

- Auth Architektur: Middleware + Dependencies (M3)
- /api/v1 akzeptiert Session OR ApiKey OR Device Token
  - Prioritaet: Session > ApiKey > Device
- Tokenformat:
  - ApiKey: uak.<id>.<secret>
  - Device: dev.<id>.<secret>
  - Session Cookie: sess.<id>.<secret>
- CSRF:
  - Double Submit Cookie
  - Enforced nur fuer session-auth mutating /api/v1/* und POST /auth/logout (C1)
- Scopes:
  - user_api_keys.scopes NULL => keine Einschraenkung
  - devices.scopes NULL => kein Zugriff (secure default)
- Superadmin:
  - users.is_superadmin => permission check short-circuit true

---

## 4) Authentifizierungsarten

### 4.1 Session (UI)
- Cookie: session_id = sess.<session_row_id>.<secret>

### 4.2 ApiKey (PAT)
- Header: Authorization: ApiKey uak.<api_key_id>.<secret>

### 4.3 Device Token
- Header: Authorization: Device dev.<device_id>.<secret>

---

## 5) Tokenformat (Lookup-per-ID)

Ablauf
1. Token split in prefix, id, secret (Punkt-getrennt)
2. SELECT row by id
3. verify_secret(secret, stored_hash)
4. Principal setzen, last_used_at aktualisieren

Warum
- Argon2/bcrypt Hashes sind nicht DB-seitig suchbar

---

## 6) Auth Middleware (M3)

Middleware setzt request.state.principal (oder None).

Reihenfolge
1. Session Cookie
2. ApiKey Header
3. Device Header
4. None

Middleware wirft keine 401, Endpoints tun das via Dependencies.

---

## 7) CSRF (Double Submit Cookie, C1)

Geltungsbereich
- Pfad startet mit /api/v1/ oder Pfad == /auth/logout
- Method in POST/PUT/PATCH/DELETE
- Nur wenn principal.auth_type == "session"

Check
- Cookie csrf_token existiert
- Header X-CSRF-Token existiert
- cookie == header

Setzen csrf_token
- bei erfolgreichem login (Passwort oder OAuth callback)
- optional bei /auth/me falls fehlt

Fehler
- 403 csrf_failed

---

## 8) Permission Checks (RBAC + Scopes)

### 8.1 User (Session oder ApiKey)
- resolve_user_permissions(user_id) -> set of permission keys
- wenn is_superadmin true -> allow
- wenn ApiKey scopes gesetzt:
  - effective = RBAC intersect scopes
- wenn ApiKey scopes NULL:
  - effective = RBAC

### 8.2 Device
- scopes NULL => deny
- effective = scopes

Fehler
- 401 wenn unauthenticated
- 403 wenn fehlende permission

---

## 9) Auth Endpoints

### 9.1 POST /auth/login
- email + password
- validiert users.is_active und deleted_at
- erstellt user_sessions row
- setzt Cookie session_id (HttpOnly)
- setzt Cookie csrf_token (nicht HttpOnly)

### 9.2 POST /auth/logout
- erfordert Session Auth
- setzt revoked_at
- loescht session_id cookie
- optional loescht csrf_token cookie

### 9.3 GET /auth/me
- liefert aktuelles User Profil (session bevorzugt)
- optional roles + permissions

OAuth (optional)
- /auth/oauth/{provider}/start
- /auth/oauth/{provider}/callback
- Auto-Linking: primaere verifizierte Email (M1)

---

## 10) Self-Service Endpoints

- GET /api/v1/me
- PATCH /api/v1/me
- POST /api/v1/me/change-password

Theme
- UI Theme ist lokal, nicht in users gespeichert

---

## 11) Security Notes

- Keine Tokens/Secrets loggen
- Hashing:
  - password_hash, key_hash, token_hash, session_token_hash
- Rate limit / brute force (spaeter empfohlen)
- OAuth: nur primaere verifizierte Email fuer Auto-Linking

---

## 12) Akzeptanzkriterien

- Session Auth, ApiKey Auth, Device Auth funktionieren
- CSRF blockt session mutating requests ohne Token
- RBAC + scopes funktionieren, superadmin short-circuit
- Tokens sind im Format uak/dev/sess.<id>.<secret>
- /auth/login und /auth/logout funktionieren mit Cookies

---