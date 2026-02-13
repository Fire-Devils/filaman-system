# 20 – REST API (v1) – Admin Endpoints: Users + RBAC (Option B)

Status: final  
Version: v1  
Last Updated: 2026-02-13  

---

## 1) Zweck und Scope

Dieses Dokument spezifiziert Admin Endpoints fuer:
- User Verwaltung (CRUD, reset password, soft delete)
- Rollen-Zuweisung zu Usern
- Optionale direkte Permissions pro User
- Rollen Verwaltung (CRUD)
- Permissions Verwaltung (CRUD)
- Role-Permissions Mapping (Replace)

Systemobjekte
- is_system=true: editierbar, nicht loeschbar (Policy)

---

## 2) Abhaengigkeiten

- 12_api_core_conventions.md
- 02_domain_users_rbac_db.md
- Policy system delete forbidden (siehe policy doc / 00 index)

---

## 3) Permissions

- admin:users_manage
- admin:rbac_manage

---

## 4) Users Admin

GET /api/v1/admin/users
- Permission: admin:users_manage
- include_deleted optional

GET /api/v1/admin/users/{user_id}
- Permission: admin:users_manage
- Response inkl. roles + direct_permissions (wenn genutzt)

POST /api/v1/admin/users
- Permission: admin:users_manage
- Create user (setzt password_hash)

PATCH /api/v1/admin/users/{user_id}
- Permission: admin:users_manage

POST /api/v1/admin/users/{user_id}/reset-password
- Permission: admin:users_manage

DELETE /api/v1/admin/users/{user_id}
- Permission: admin:users_manage
- Soft delete:
  - deleted_at=now
  - is_active=false

Roles mapping
- PUT /api/v1/admin/users/{user_id}/roles
  - replace role_ids
- POST /api/v1/admin/users/{user_id}/roles
  - add single role_id
- DELETE /api/v1/admin/users/{user_id}/roles/{role_id}
  - remove

Direct permissions (optional)
- PUT /api/v1/admin/users/{user_id}/permissions
  - replace permission_ids

---

## 5) Roles Admin

GET /api/v1/admin/roles
- Permission: admin:rbac_manage

GET /api/v1/admin/roles/{role_id}
- Permission: admin:rbac_manage
- Response inkl. permissions

POST /api/v1/admin/roles
- Permission: admin:rbac_manage

PATCH /api/v1/admin/roles/{role_id}
- Permission: admin:rbac_manage

DELETE /api/v1/admin/roles/{role_id}
- Permission: admin:rbac_manage
- Behavior:
  - wenn is_system=true -> 409 system_entity_delete_forbidden
  - sonst RESTRICT wenn referenziert (user_roles, role_permissions) -> 409

PUT /api/v1/admin/roles/{role_id}/permissions
- Permission: admin:rbac_manage
- replace permission_ids

---

## 6) Permissions Admin

GET /api/v1/admin/permissions
- Permission: admin:rbac_manage

GET /api/v1/admin/permissions/{permission_id}
- Permission: admin:rbac_manage

POST /api/v1/admin/permissions
- Permission: admin:rbac_manage
- optional v1

PATCH /api/v1/admin/permissions/{permission_id}
- Permission: admin:rbac_manage

DELETE /api/v1/admin/permissions/{permission_id}
- Permission: admin:rbac_manage
- Behavior:
  - wenn is_system=true -> 409 system_entity_delete_forbidden
  - sonst RESTRICT wenn referenziert (role_permissions, user_permissions) -> 409

---

## 7) Akzeptanzkriterien

- Admin kann Users anlegen, deaktivieren, soft delete
- Admin kann Rollen/Permissions verwalten
- Systemobjekte koennen nicht geloescht werden (409)
- RESTRICT Konflikte liefern 409 conflict mit details

---