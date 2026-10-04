# Shared Filament Create/Edit Form Design

## Goal

Make filament creation and editing use one shared form implementation so field names, ordering, catalog lookup, manufacturer creation, color selection, validation, and future changes cannot drift between the two pages.

The Edit page must also gain the configured FilaManDB lookup and the color filter. Catalog-applied filament values remain a draft until the user presses Save. Every edit that differs from the loaded filament is visibly marked as unsaved, including ordinary typing and catalog-applied changes.

## Scope

In scope:

- One shared form markup component used by both `/filaments/new` and `/filaments/[id]/edit`.
- One shared client controller for reference-data loading, manufacturer creation, catalog lookup, color filtering and selection, field population, validation, extra fields, and payload collection.
- Create- and edit-specific loading, persistence, button text, and redirects supplied by thin route wrappers.
- Dirty-state tracking on Edit against the fully loaded original filament.
- Existing configured lookup source: FilaManDB or disabled.
- Existing duplicate-filament preload on Create.

Out of scope:

- Changing backend filament create/update contracts.
- Combining the existing create and edit URLs.
- Automatic saving, navigation prompts, undo history, or per-field revert buttons.
- Bulk import and additional catalog trait storage.

## Architecture

### Shared markup

Create `frontend/src/components/FilamentForm.astro`. It owns the complete form body, including:

- manufacturer selector and catalog lookup mount;
- base material, diameter, variant/additive, finish, and product/series fields;
- color mode, color filter button, selected colors, color grid, and inline color editor;
- manufacturer color name, weights, density, spool defaults, price, and purchase URL;
- system and filament-specific extra fields;
- error, dirty-status, submit, and cancel controls.

The component accepts only presentation-level props: `mode`, cancel URL, and translated submit/title keys where needed. It does not fetch or save data.

### Shared controller

Create `frontend/src/lib/filament-form.ts`. It exports one initializer that receives the form root and mode-specific callbacks. The controller reuses the existing helpers for manufacturer dialogs, catalog search, entity extra fields, inline color editing, caching, and table color filtering.

The controller owns all behavior currently duplicated across the two pages:

- loading manufacturers, material types, colors, and system fields;
- adding a manufacturer and selecting it in place;
- resolving the configured catalog source and binding immediate search after manufacturer selection;
- rendering and applying catalog results;
- managing custom material types and default density;
- managing single/multi-color selection and ordering;
- binding the smart color-filter popover;
- rendering and collecting extra fields;
- applying initial data and collecting validated form data.

The controller exposes a small route-facing interface:

- initialize shared reference data;
- apply initial filament/duplicate data;
- capture an Edit baseline;
- collect normalized scalar and color payloads;
- set submit/error state;
- destroy listeners and lookup instances if the page unloads.

### Thin pages

`frontend/src/pages/filaments/new.astro` renders the shared component, loads duplicate data from session storage when present, and persists with the existing `POST /api/v1/filaments` request.

`frontend/src/pages/filaments/[id]/edit.astro` keeps its loading/error shell, renders the same component, loads the existing filament, applies it, captures the baseline, and persists using the existing scalar `PATCH` followed by the color `PUT`.

The separate persistence adapters preserve current backend behavior while every visible and interactive form concern comes from the shared basis.

## Catalog Lookup Behavior

Both modes use the app setting to select FilaManDB or disabled. Selecting a manufacturer immediately displays the search field when lookup is enabled. There is no intermediate “Load” button.

Selecting a catalog result applies its available filament values to the form only. It may update product/series name, base material, material variant, finish, diameter, colors, manufacturer color name, weight, density, spool defaults, price, or purchase URL. A missing catalog value never erases an existing draft value, including when the result selects a different manufacturer.

Reference-record exception: the existing FilaManDB preparation endpoint may create reusable manufacturer and color records as soon as a catalog result is selected. Canceling the form does not remove those reference records. The filament itself is not created or updated until Save.

On Edit, these changes use the same dirty-state mechanism as manual edits. No request mutating the filament is sent until Save is submitted.

## Dirty-State Model

Dirty tracking is enabled only after the Edit page has loaded all reference data, populated the existing filament, rendered extra fields, and captured a normalized baseline.

The baseline includes:

- every scalar form value;
- selected material/custom-material state;
- ordered color IDs and color mode/pattern;
- system and filament-specific extra-field values.

On input, change, color selection/reordering, inline color creation, manufacturer creation/selection, or catalog application, the controller compares the affected value with the baseline.

Each changed field wrapper receives an `is-dirty` state and a localized visible “Changed” marker, so the indication is not color-only. The full Colors section is treated as one field and highlights when selection, order, mode, or pattern differs. Restoring a value to its original normalized value removes its marker. A localized form-level status announces whether unsaved changes exist.

Create mode does not show dirty markers because the entire record is new.

## Validation and Error Handling

Shared validation covers required manufacturer, product/series name, base material (including custom material), diameter, and at least one color. Create and Edit use identical normalization for optional numbers, empty strings, and extra fields.

Lookup failures remain non-destructive: existing draft values stay intact and the lookup area shows the existing catalog error message. Save failures retain all draft values and dirty markers. Edit’s existing two-request save behavior remains; if the color request fails after the scalar request succeeds, the user sees the current update error and can retry.

## Accessibility

- Existing labels and field associations remain intact in the shared markup.
- Dirty state uses text plus styling, not color alone.
- The form-level dirty status uses an appropriate live/status region.
- The color-filter trigger retains its accessible name and keyboard behavior.
- Manufacturer and catalog dialogs restore focus when closed.

## Testing

Add focused DOM tests for the shared controller covering:

- Create and Edit initialize the same field and control set.
- The Edit page exposes the configured lookup immediately after manufacturer selection.
- The Edit page includes and applies the color filter.
- Manual changes and catalog-applied changes become dirty without sending save requests.
- Reverting scalar and color changes clears their dirty state.
- Create mode never displays dirty markers.
- The shared collector produces the existing create and edit payload shapes.
- Duplicate preload and existing-filament preload both populate the shared form correctly.

Retain the existing lookup, manufacturer-dialog, color-filter, locale-parity, frontend build/type, and backend endpoint tests. No new dependency is required.

## Success Criteria

- Both routes render the same shared form component and initialize the same shared controller.
- Edit has the same source-selected catalog search and smart color filter as Create.
- No catalog-applied or manual filament edit is persisted before Save; reference-record creation follows the exception above.
- Every Edit value differing from its baseline is marked, and restoring it removes the mark.
- Create duplication, Edit loading, extra fields, and existing persistence contracts continue to work.
- Frontend tests, lint/type checks, and production build pass; focused backend tests remain green.
