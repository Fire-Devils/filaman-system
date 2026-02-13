# 22 – OpenAPI DTO Admin Addendum (v1)

Status: final  
Version: v1  
Last Updated: 2026-02-13  

---

## 1) Zweck und Scope

Ergaenzt 21_openapi_dto_todo.md um Admin Endpoints DTOs:
- Users Admin
- Roles Admin
- Permissions Admin

---

## 2) Users Admin DTOs
- AdminUserSummary
- AdminUserListResponse
- AdminUserDetail
- AdminUserCreateRequest
- AdminUserUpdateRequest
- AdminUserResetPasswordRequest
- AdminUserRolesReplaceRequest
- AdminUserRoleAddRequest
- AdminUserPermissionsReplaceRequest (optional)

---

## 3) Roles Admin DTOs
- RoleSummary
- RoleListResponse
- RoleDetail (inkl. permissions)
- RoleCreateRequest
- RoleUpdateRequest
- RolePermissionsReplaceRequest

---

## 4) Permissions Admin DTOs
- PermissionSummary
- PermissionListResponse
- PermissionDetail
- PermissionCreateRequest
- PermissionUpdateRequest

---