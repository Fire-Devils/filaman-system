# 18 – REST API (v1) – Ressourcen 6: User API Keys (Self-Service)

Status: final  
Version: v1  
Last Updated: 2026-02-13  

---

## 1) Zweck und Scope

Dieses Dokument spezifiziert:
- User verwaltet eigene API Keys (PAT) (K1)
- Klartext Token nur einmal anzeigen
- Scopes optional (NULL = keine Einschraenkung)

Nicht Teil
- Admin RBAC Endpoints (20)
- Auth core (08)

---

## 2) Abhaengigkeiten

- 12_api_core_conventions.md
- 02_domain_users_rbac_db.md (user_api_keys)
- 08_backend_auth_full.md (tokenformat)

---

## 3) Permissions

Self Permissions (v1)
- user_api_keys:read_own
- user_api_keys:create_own
- user_api_keys:update_own
- user_api_keys:rotate_own
- user_api_keys:delete_own

Admin optional
- admin:users_manage (oder *_any permissions)

---

## 4) Endpoints (Self)

GET /api/v1/me/api-keys
- Permission: user_api_keys:read_own

POST /api/v1/me/api-keys
- Permission: user_api_keys:create_own
- Response: api_key + token (uak.<id>.<secret>)

PATCH /api/v1/me/api-keys/{api_key_id}
- Permission: user_api_keys:update_own
- Update name/scopes (ohne token)

POST /api/v1/me/api-keys/{api_key_id}/rotate
- Permission: user_api_keys:rotate_own
- Response: token (uak.<id>.<secret>)

DELETE /api/v1/me/api-keys/{api_key_id}
- Permission: user_api_keys:delete_own
- Behavior: hard delete (v1) oder optional soft delete (nicht erforderlich)

---

## 5) Scopes Semantik

- scopes NULL => keine Einschraenkung (Key hat volle RBAC Rechte des Users)
- scopes gesetzt => intersection (einschraenkend)

---

## 6) Akzeptanzkriterien

- Token wird nur einmal angezeigt (create/rotate)
- Auth mit ApiKey funktioniert im Format uak.<id>.<secret>
- scopes Semantik korrekt

---