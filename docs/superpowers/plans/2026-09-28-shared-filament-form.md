# Shared Filament Form Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Create and Edit use one form implementation, with identical catalog lookup and color filtering plus draft-only dirty highlighting on Edit.

**Architecture:** `FilamentForm.astro` owns markup; `filament-form.ts` owns all shared client behavior. The two routes retain only initial-data loading and their existing POST versus PATCH/PUT persistence.

**Tech Stack:** Astro 5, TypeScript, Vitest/Happy DOM, existing FilaMan helpers and CSS.

**Spec:** `docs/superpowers/specs/2026-09-28-shared-filament-form-design.md`

## Global Constraints

- Preserve `/filaments/new`, `/filaments/[id]/edit`, and all backend request contracts.
- Reuse existing manufacturer-dialog, catalog-lookup, color-filter, inline-color, cache, and extra-field helpers; add no dependency.
- Missing catalog values never clear existing draft values; only Save writes the filament.
- Dirty markers appear only in Edit and include visible text, not color alone.
- Checkpoint the already-verified OFD/Create work separately before refactor commits.

## Review Focus

- Async reference/extra-field loading must finish before the Edit baseline is captured (Task 2 test).
- Equivalent numeric display values such as `1`, `1.0`, and `1.00` must not create false dirty state (Task 2 test).
- Color selection order, mode, and pattern are part of dirty state (Task 2 test).
- Sparse catalog results preserve existing draft fields (Task 2 test).
- Save errors retain entered values and dirty markers for retry (Task 2 test).

---

### Task 1: Extract the shared form and migrate Create

**Files:**
- Create: `frontend/src/components/FilamentForm.astro`
- Create: `frontend/src/lib/filament-form.ts`
- Create: `frontend/src/lib/filament-form.dom.test.ts`
- Modify: `frontend/src/pages/filaments/new.astro`

**Interfaces:**
- `FilamentForm.astro` props: `{ mode: 'create' | 'edit'; cancelHref: string }`.
- `createFilamentFormController(options: { form: HTMLFormElement; mode: 'create' | 'edit'; onSubmit(payload: FilamentFormPayload): Promise<void> }): FilamentFormController`.
- Controller methods: `loadReferenceData()`, `applyInitialData(data)`, `captureBaseline()`, `collectPayload()`, `setSubmitting(active)`, `showError(message)`, `destroy()`.
- `collectPayload()` returns `{ scalar, colors }`, where `colors` retains ordered `{ color_id, position }` entries.

- [ ] **Step 1: Add failing DOM tests** for shared initialization, immediate configured lookup after manufacturer selection, color-filter binding, Create payload collection, and duplicate-data population.
- [ ] **Step 2: Run** `npm test -- src/lib/filament-form.dom.test.ts`; expect failures because the module does not exist.
- [ ] **Step 3: Extract markup and behavior.** Move the complete form body into `FilamentForm.astro`; move reference loading, manufacturer creation, lookup application, type/density logic, colors, filtering, extra fields, validation, and payload normalization into `filament-form.ts`. Keep Create’s POST/redirect and duplicate session-storage read in the route wrapper.
- [ ] **Step 4: Run** `npm test -- src/lib/filament-form.dom.test.ts src/lib/filamentdb-lookup.dom.test.ts src/lib/manufacturer-dialog.dom.test.ts src/lib/table-column-filters.dom.test.ts` and `npm run check`; expect pass/zero errors.
- [ ] **Step 5: Commit** `refactor: share filament form behavior`.

### Task 2: Add baseline dirty tracking and draft catalog updates

**Files:**
- Modify: `frontend/src/components/FilamentForm.astro`
- Modify: `frontend/src/lib/filament-form.ts`
- Modify: `frontend/src/lib/filament-form.dom.test.ts`
- Modify: `frontend/src/i18n/en.json`
- Modify: `frontend/src/i18n/de.json`
- Modify: `frontend/src/i18n/fr.json`

**Interfaces:**
- `captureBaseline()` snapshots normalized scalar values, custom material state, ordered colors, mode/pattern, and extra fields.
- `applyInitialData(data, source?: 'initial' | 'duplicate' | 'catalog')` preserves absent values for `source: 'catalog'`.
- Dirty wrappers use `.is-dirty`; localized keys are `filaments.changed` and `filaments.unsavedChanges`.

- [ ] **Step 1: Add failing tests** for scalar change/revert, numeric normalization, delayed baseline capture, color order/mode/pattern change/revert, sparse catalog application, no mutation request before submit, Create having no markers, and save failure retaining the draft.
- [ ] **Step 2: Run** `npm test -- src/lib/filament-form.dom.test.ts`; expect the new dirty-state assertions to fail.
- [ ] **Step 3: Implement minimal dirty tracking.** Compare current normalized snapshots to the captured baseline after each form/color/extra-field update; toggle the field wrapper’s marker and the live form-level status. Route catalog population through `applyInitialData(..., 'catalog')`.
- [ ] **Step 4: Run** `npm test -- src/lib/filament-form.dom.test.ts src/lib/i18n-catalog.test.ts`; expect pass.
- [ ] **Step 5: Commit** `feat: highlight unsaved filament changes`.

### Task 3: Migrate Edit and lock the shared architecture

**Files:**
- Modify: `frontend/src/pages/filaments/[id]/edit.astro`
- Modify: `frontend/src/lib/filament-form.dom.test.ts`
- Create: `frontend/src/lib/filament-form-source.test.ts`

**Interfaces:**
- Consumes Task 1’s `FilamentForm` and controller without edit-only copies of form logic.
- Edit sequence: `loadReferenceData()` → GET filament → `applyInitialData(data, 'initial')` → `captureBaseline()` → reveal form.
- Save sequence remains scalar PATCH then colors PUT, followed by cache invalidation and redirect.

- [ ] **Step 1: Add failing source/DOM tests** asserting both routes render `FilamentForm`, neither route contains its own `<form id="filament-form">`, Edit exposes the configured lookup and color filter through the controller, and no PATCH/PUT occurs until submit.
- [ ] **Step 2: Run** `npm test -- src/lib/filament-form-source.test.ts src/lib/filament-form.dom.test.ts`; expect Edit architecture assertions to fail.
- [ ] **Step 3: Replace Edit’s duplicate markup/controller** with the shared component and controller. Keep only ID/back-link handling, loading/error shell, GET, PATCH/PUT, redirect, and cache invalidation.
- [ ] **Step 4: Run** `npm test`, `npm run lint`, `npm run check`, `npm run build`, and `git diff --check`; expect all tests/builds to pass with zero errors.
- [ ] **Step 5: Run backend regression** `cd backend && .venv/bin/pytest tests/test_app_settings.py tests/test_ofd_proxy.py tests/test_filamentdb_proxy.py tests/test_search_utils.py -q`; expect pass.
- [ ] **Step 6: Commit** `refactor: use shared filament form for editing`.
