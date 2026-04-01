# Logo Integration Plan: Spoolman PR 857 into FilaMan

## Goal

Bring manufacturer logos into FilaMan, based on the non-print parts of Spoolman PR 857.

This phase covers:
- manufacturer management
- manufacturer list visibility
- filament show and edit visibility
- spool show and edit visibility

This phase explicitly does not cover any print or label-export logo work.

## Current FilaMan Reality

- FilaMan does not have a separate manufacturer edit page.
- Manufacturer create and edit currently happen inside the modal in `frontend/src/pages/manufacturers/index.astro`.
- The backend manufacturer model currently has no dedicated logo fields.
- Manufacturer data already flows into filament and spool detail responses, so logo visibility can piggyback on the existing nested manufacturer payload once the backend schema is extended.

## Requested UX

On the manufacturer editor surface:
- allow upload of a logo file
- allow manual entry of a logo URL
- show the stored file path for the uploaded logo
- show a live preview of the effective logo

On other surfaces:
- show the logo in the manufacturer table
- show the logo in filament show and edit screens
- show the logo in spool show and edit screens

## Scope

### In Scope

1. Backend manufacturer logo persistence.
2. Logo upload endpoint and file storage.
3. Manufacturer modal updates for upload, URL, file path display, and preview.
4. Manufacturer list/table logo column.
5. Logo visibility on filament show and filament edit.
6. Logo visibility on spool show and spool edit.

### Out Of Scope

- Print page logo rendering.
- Print-specific monochrome conversion.
- Export/AML/PNG behavior.
- Vendor-logo manifest auto-discovery from Spoolman.
- Logo packs or bundled static logo libraries.

## Proposed Data Model

Add dedicated logo fields to `Manufacturer` instead of burying this in generic custom fields.

Recommended fields:
- `logo_url`: optional manually entered external or absolute app URL
- `logo_file_path`: optional server-managed relative path for uploaded files

Recommended response convenience field:
- `resolved_logo_url`: computed URL the frontend should use for display

Why this shape:
- supports both upload and manual URL cleanly
- preserves the actual stored file path the user asked to see
- keeps rendering logic simple in the frontend

Assumed precedence:
- if `logo_file_path` exists, use the uploaded local file as the effective logo
- otherwise use `logo_url`

If we want explicit user override later, we can add a source selector, but that is unnecessary for the first pass.

## Backend Plan

### 1. Schema and migration

Update:
- `backend/app/models/filament.py`
- `backend/app/api/v1/schemas_filament.py`

Add a migration for the `manufacturers` table with:
- `logo_url`
- `logo_file_path`

Extend create, update, and response schemas so these fields round-trip through the API.

### 2. Upload handling

Add a dedicated upload endpoint instead of overloading the JSON `PATCH` endpoint.

Recommended endpoint:
- `POST /api/v1/manufacturers/{manufacturer_id}/logo`

Behavior:
- accept multipart form upload via `UploadFile`
- validate file is an image
- validate non-empty payload
- generate a safe unique filename
- save the file under a dedicated manufacturer-logo storage directory
- return updated manufacturer data including `logo_file_path` and `resolved_logo_url`

Also add a delete/clear path via existing `PATCH` or a small dedicated route so users can remove uploaded logos cleanly.

### 3. File storage and serving

Store uploaded logos in a single predictable location, for example:
- `backend/data/manufacturer-logos/`

Serve them under a stable frontend-visible URL, for example:
- `/media/manufacturer-logos/<filename>`

Implementation notes:
- keep stored path relative, not absolute
- do not store raw temporary upload names
- keep final URL generation centralized in backend code

### 4. Validation rules

Initial pass should validate:
- MIME type starts with `image/`
- empty files are rejected
- filename sanitized before persistence

Nice-to-have but not mandatory in phase 1:
- max file size guard
- dimension normalization
- image transcoding

## Frontend Plan

### 1. Shared API helper updates

Update `frontend/src/lib/api.ts` with a `postFormData` helper so the manufacturer editor can upload files without bypassing the shared API wrapper.

### 2. Manufacturer editor surface

Primary file:
- `frontend/src/pages/manufacturers/index.astro`

Extend the existing modal form with a new `Logo` section containing:
- file upload input
- logo URL input
- read-only display of the saved uploaded file path
- preview box showing the effective logo
- clear/remove controls for upload and URL when needed

Because manufacturer edit is modal-based in FilaMan, this plan treats that modal as the requested “manufacturer edit page.”

### 3. Manufacturer table

Add a logo column to the manufacturers table in `frontend/src/pages/manufacturers/index.astro`.

Column behavior:
- small logo thumbnail when available
- simple fallback text or placeholder when absent
- keep sorting/filtering behavior unchanged for the first pass

### 4. Shared logo rendering helper

Add a small shared frontend helper/component, likely:
- `frontend/src/components/manufacturer-logo.astro` or a small TS utility + render helper

Responsibilities:
- prefer `resolved_logo_url`
- fall back cleanly when no logo exists
- keep image sizing consistent across list/detail/edit contexts

### 5. Filament surfaces

Files:
- `frontend/src/pages/filaments/[id]/index.astro`
- `frontend/src/pages/filaments/[id]/edit.astro`

Planned visibility:
- show manufacturer logo near manufacturer name on the filament detail page
- show a small preview of the selected manufacturer logo in the filament edit page near the manufacturer selector

### 6. Spool surfaces

Files:
- `frontend/src/pages/spools/[id]/index.astro`
- `frontend/src/pages/spools/[id]/edit.astro`

Planned visibility:
- show manufacturer logo in spool detail alongside filament/manufacturer context
- show the currently selected filament's manufacturer logo in spool edit once a filament is selected

Note:
- spool edit selects filament, not manufacturer directly, so the logo preview there should derive from the chosen filament's nested manufacturer data.

## Suggested Execution Order

1. Add backend manufacturer logo columns and migration.
2. Add response fields and resolved URL logic.
3. Add upload endpoint and media serving.
4. Add shared frontend `postFormData` helper.
5. Extend manufacturer modal with URL, upload, file path, preview.
6. Add manufacturer table logo column.
7. Add logo visibility to filament show/edit.
8. Add logo visibility to spool show/edit.
9. Add i18n strings and final polish.

## Main Risks

- Upload storage needs a stable served path or the frontend will only be able to show local preview, not persisted images.
- Spool edit does not edit manufacturer directly, so the preview logic must stay read-only and derived from the selected filament.
- If we only store one logo field, upload and URL support become ambiguous. Keeping both fields avoids this.
- Large images could hurt list rendering if thumbnails are not constrained in CSS.

## Validation Targets

- Create a manufacturer with only a logo URL and verify preview and persistence.
- Upload a manufacturer logo file and verify the returned file path is shown.
- Edit a manufacturer with both fields present and verify the effective logo preview is stable.
- Confirm the manufacturer list renders logo thumbnails without breaking table layout.
- Confirm filament detail and filament edit show the correct manufacturer logo.
- Confirm spool detail and spool edit show the correct manufacturer logo for the selected filament.
- Confirm removing a logo does not break existing manufacturer data.

## Deliberate Difference From Spoolman PR 857

Spoolman PR 857 includes broader logo-pack and print-logo behavior.

For FilaMan phase 1, we should port only the core business value:
- manufacturer logo persistence
- upload plus URL support
- UI visibility across manufacturer, filament, and spool screens

Print-specific logo workflows can follow in a later phase once the base logo model is stable.