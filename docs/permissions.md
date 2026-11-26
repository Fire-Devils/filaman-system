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

Examples: manufacturers (`api/v1/filaments.py:185`), colors (`:492`) and
locations (`api/v1/spools.py:156`) are read with `PrincipalDep`, while
`manufacturers:create/update/delete`, `colors:*` and `locations:*` are guarded
with `RequirePermission`.

The print job log follows the same rule: `GET /print-jobs`, `/print-projects` and
`/spools/{id}/print-jobs` are read with `PrincipalDep`; `print_jobs:create`
(create jobs/projects), `print_jobs:update` (edit, complete, cancel, photo) and
`print_jobs:delete` guard the writes. Role `user` holds create and update;
deleting is admin only. Completing a job books spool consumption itself, so it
does not additionally need `spool_events:create_consumption`.

Consequences, on purpose:

- A `viewer` can read everything, no matter which read keys the role holds.
- Read keys that nothing ever checked were removed rather than left in the role
  editor as decoration — `colors:read`, `locations:read` and
  `manufacturers:read` in migration `d5f3b8c2a614`.

### The read keys that *are* enforced

| Key | Where | Why |
| --- | --- | --- |
| `spool_events:read` | `api/v1/spools.py:801,1187` | Event history is separate from the spool itself |
| `display:read` | `api/v1/display.py:81,101` | A wall panel device gets exactly this scope and nothing else — see [display-api.md](display-api.md) |
| `printers:read`, `filaments:read`, `spools:read` | `api/v1/printers.py:623,643,651`, inside `ensure_any_permission(...)` | Printer actions that touch a spool or filament; the plain list endpoints do not check them |
| `spools:read` | `api/v1/devices.py:210,344,870` | Device status for the UI: active devices, RFID write status, last tag-scan result of a device |
| `spools:read` | `api/v1/tag.py`, in `_reader_principal` (`/tag/scan`, `/tag/last-scan`, `/tag/readers`) | Tag readers and the browser that follows them. A registered device passes on its token alone, like `scale/weight`; users and API keys need the key |

`POST /api/v1/filamentdb/prepare-filament` is not a read despite living next to the FilamentDB lookups: it creates local manufacturers and colours, so it requires `filaments:create` (it is the first step of creating a filament). The FilamentDB `GET` proxy endpoints stay open to every authenticated principal.

Every default role (`viewer`, `user`, `admin`) holds `spools:read`, so these
checks only bite for custom roles without it or for API keys whose scopes leave
it out.

## FilaMan-DB community (`filamentdb:contribute`)

`filamentdb:contribute` guards everything that sends to, rates on or reports to
the FilaMan-DB with the stored API token: `POST /filamentdb/contributions/preview`,
`/submit`, `/refresh`, and `PUT .../print-profiles/{id}/rating`,
`POST .../print-profiles/{id}/report`. Each uses it as a dependency
(`principal=RequirePermission("filamentdb:contribute")`) in the function head.
It is seeded for the `admin` role only; grant it to other roles in the role
editor. Because `seed_permissions()` inserts at startup, no migration is needed
to add the key.

Neighbouring rules:

- The token itself (set, test, remove: `/filamentdb/token`) is a system setting
  and needs `admin:system`. It is never returned, only "saved" plus the display
  name. It is stored Fernet-encrypted with a key of its own (`FILAMAN_ENC_KEY`,
  else the file `DATA_DIR/.filaman_enc.key`), not `OIDC_ENC_KEY`.
- Adopting a community print profile (`POST .../print-profiles/{id}/import`)
  creates a local profile and needs `filaments:update`.
- Reading stays open: `GET /filamentdb/contributions`, `/contributions/status`
  and the community profile search use `PrincipalDep`.

## API keys are self-service

`backend/app/api/v1/me_api_keys.py` (create, list, delete) preserves ownership-based
self-service for user sessions and unrestricted user API keys. A `viewer` can
still create a personal key; role grants for these operations do not restrict
this self-service access. Keys cannot do more than their owner.

Scoped credentials must additionally include the corresponding
`user_api_keys:read_own`, `:create_own` or `:delete_own` scope. A delegated key
inherits its parent's scope ceiling. Devices have no user account and cannot
manage personal keys.

These three keys remain available as credential scopes. The permission-hygiene
test checks that each key participates in an application permission or scope check.
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
