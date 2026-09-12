# Permissions and authorization

How FilaMan decides who may do what, and — just as important — what the role
editor does **not** control. Written down because the gaps used to look like
bugs; they are a deliberate design (GitHub issue #151).

## The model

Permission keys are `resource:action` (e.g. `spools:create`) and are seeded in
`backend/app/core/seeds/__init__.py`. A principal is one of three things
(see AGENTS.md → Authentication): a logged-in **user**, an **API key**, or a
registered **device**.

- Users get permissions from their role plus per-user grants.
- An API key's effective permissions are the **intersection** with its owner's,
  so a key can never exceed the user who created it.
- A device is authorized by its `scopes` list only. `scopes` is nullable with no
  default, and `NULL` means deny — a device gets exactly the keys you give it.

Two dependencies enforce keys, both in `backend/app/api/deps.py`:

- `RequirePermission("resource:action")` — must be used **as a dependency**, not
  called inside the handler body, or it checks nothing.
- `ensure_any_permission(db, principal, *keys)` — any one of several keys.

## Reading is open to every authenticated principal

**Rule: list and detail endpoints use `PrincipalDep`, not `RequirePermission`.**
Anyone who is authenticated at all may read. Authorization starts at writing.

Examples: manufacturers (`api/v1/filaments.py:184`), colors (`:491`) and
locations (`api/v1/spools.py:151`) are read with `PrincipalDep`, while
`manufacturers:create/update/delete`, `colors:*` and `locations:*` are guarded
with `RequirePermission`.

Consequences, on purpose:

- A `viewer` can read everything, no matter which read keys the role holds.
- Read keys that nothing ever checked were removed rather than left in the role
  editor as decoration — `colors:read`, `locations:read` and
  `manufacturers:read` in migration `d5f3b8c2a614`.

### The read keys that *are* enforced

| Key | Where | Why |
| --- | --- | --- |
| `spool_events:read` | `api/v1/spools.py:694,1080` | Event history is separate from the spool itself |
| `display:read` | `api/v1/display.py:56,76` | A wall panel device gets exactly this scope and nothing else — see [display-api.md](display-api.md) |
| `printers:read`, `filaments:read`, `spools:read` | `api/v1/printers.py:623,643,651` only, inside `ensure_any_permission(...)` | Printer actions that touch a spool or filament; the plain list endpoints do not check them |

## API keys are self-service

`backend/app/api/v1/me_api_keys.py` (create, list, delete) is scoped to the
caller's own keys via `PrincipalDep` and checks no permission. So
`user_api_keys:read_own`, `:create_own` and `:delete_own` have no effect — a
`viewer` can create a personal API key even though the role does not grant
`create_own`. The impact is bounded by the intersection rule above: the key
cannot do more than its owner.

These three keys are kept (their endpoints exist and could start checking) and
are listed in `KNOWN_UNENFORCED` in `backend/tests/test_permission_hygiene.py`.
`user_api_keys:update_own` and `:rotate_own` were removed in migration
`d5f3b8c2a614` — there is no update and no rotate endpoint at all.

## Changing the set of keys

- `seed_permissions()` only **inserts**, never deletes. Removing a key therefore
  **always** needs an Alembic migration, or the row survives on existing
  installations and keeps showing up in the role editor.
- Model a removal on `alembic/versions/d5f3b8c2a614_remove_unenforced_read_permissions.py`:
  delete the rows in `role_permissions` and `user_permissions` explicitly (SQLite
  only enforces foreign keys with `PRAGMA foreign_keys=ON`), keep `upgrade()`
  idempotent, and restore only the permission rows in `downgrade()`.
- `backend/tests/test_permission_hygiene.py` is the guard: every seeded key must
  appear somewhere in `app/`, except the explicit `KNOWN_UNENFORCED` set. A new
  decorative key turns the suite red. Add removals to both the migration and
  `REMOVED_BY_MIGRATION`.
- The role editor needs no change: `frontend/src/pages/admin/roles.astro` loads
  `/api/v1/admin/permissions` and groups by `category`.

## Historical specs

`_spec/27_rbac_permissions_full_list.md` and
`_spec/28_rbac_default_roles_mapping.md` are frozen v1 specs from 2026-02-13 and
still list the removed keys. This document supersedes them for anything
permission-related.
