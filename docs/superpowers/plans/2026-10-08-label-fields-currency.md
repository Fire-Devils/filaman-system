# Label Fields, Currency, and Token Dock Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every new standard filament field and the missing spool fields usable in label templates, organize their picker, and keep spool purchase totals in one currency.

**Architecture:** Extend the existing label-data builders and token catalog; do not create another label pipeline. Render the shared field dock as compact native collapsible groups and let the preview workspace own vertical scrolling. Keep purchase amounts in the configured application currency without a database migration.

**Tech Stack:** Astro, TypeScript, Vitest/happy-dom, existing Playwright workspace check, GitHub CLI.

**Spec:** `docs/superpowers/specs/2026-10-08-label-fields-currency-design.md`

## Global Constraints

- Preserve saved token names and templates; new names are additive.
- Purchase totals use the configured app currency. No per-spool currency column or exchange-rate conversion.
- A declared filament-price currency mismatch leaves the new spool's purchase-price suggestion blank; absent or matching currency retains the editable suggestion.
- Preserve the existing unrelated unstaged responsive-layout edits; stage only task-owned paths.
- Keep the reduced standard-label editor reduced; organize the freeform token dock.

## Review Focus

- A zero reference price must prefill as `0`, not disappear; Task 1 tests it.
- A `false` discontinued flag and one-ended numeric ranges must render meaningful tokens; Task 2 tests them.
- A spool's physical dimensions must override product defaults while old template tokens still render; Task 3 tests both.
- A second RFID chip must have its own token without replacing the primary chip; Task 3 tests it.
- Search must restore each group's prior collapse state and remain keyboard-usable; Task 4 tests it.

---

## File Map

- `frontend/src/lib/format.ts`, `frontend/src/pages/spools/new.astro`: one-currency purchase-price suggestion.
- `frontend/src/lib/filament-label-data.ts`, `frontend/src/lib/spool-label-data.ts`: canonical label values and query fallback.
- `frontend/src/lib/label-designer.ts`, `frontend/src/lib/label-template.ts`: values available to template rendering.
- `frontend/src/lib/label-token-catalog.ts`: token choices and functional group metadata.
- `frontend/src/components/freeform-label/FieldDock.astro`, `frontend/src/lib/freeform-label/field-drawer.ts`, `frontend/src/lib/label-extra-fields.ts`: grouped picker, compact search, and scrolling.
- `frontend/src/i18n/{en,de,fr}.json`: group and search labels not already translated.
- Existing label tests and print pages: contracts for single and batch labels.

### Task 1: One-Currency Spool Price Suggestion

**Files:** Modify `frontend/src/lib/format.ts`, `frontend/src/pages/spools/new.astro`; create `frontend/src/lib/format.test.ts`.

**Interfaces:** Produce `suggestSpoolPurchasePrice(price: number | null | undefined, sourceCurrency: string | null | undefined, appCurrency: string): string`. Later tasks use `getCurrency()` from the same module for the label's computed purchase-currency token.

- [ ] **Step 1: Write failing tests** for matching case-insensitive currency → price string, absent currency → price string, different currency → `''`, null price → `''`, and zero price → `'0'`.
- [ ] **Step 2: Verify red:** `cd frontend && npx vitest run src/lib/format.test.ts` fails on the missing helper.
- [ ] **Step 3: Implement** the helper and use it where selecting a filament fills `#purchase_price`; initialize the app currency before that selection can occur. Keep the field editable and do not change backend purchase-price storage.
- [ ] **Step 4: Verify green:** the focused test passes; inspect new-spool selection with matching and mismatched filament currency.
- [ ] **Step 5: Commit** only these three files.

### Task 2: Native Filament Tokens End to End

**Files:** Modify `frontend/src/lib/filament-label-data.ts`, `frontend/src/lib/label-designer.ts`, `frontend/src/lib/label-template.ts`, `frontend/src/lib/label-token-catalog.ts`, and `frontend/src/lib/label-token-contract.test.ts`.

**Interfaces:** Each new model key has a `{filament.<key>}` rendering key: `extruder_temp_range_c`, `bed_temp_range_c`, `manufacturer_sku`, `datasheet_url`, `image_url`, `is_discontinued`, `drying_temp_c`, `drying_time_hours`, `softening_temp_c`, `cooling_fan_range_percent`, `chamber_temp_c`, `max_volumetric_speed_mm3_s`, `flow_ratio`, `pressure_advance_k`, `ams_compatibility`, `build_plate_compatibility`, `price_currency`. `FilamentLabelData` and `DesignerFlatLabelData` carry string values; `SpoolData` receives the matching namespaced keys. `LabelTokenChoice` gains `section: string` for Task 4. Existing `{filament.extruder_temp}` and `{filament.bed_temp}` remain renderable.

- [ ] **Step 1: Write a failing table-driven contract test** with representative values for all 17 keys, including `false`, zero, an open-ended range, comma-joined compatibility lists, and empty values. Assert both the rendered text and picker membership of each canonical token; assert the two legacy temperature aliases still render.
- [ ] **Step 2: Verify red:** `cd frontend && npx vitest run src/lib/label-token-contract.test.ts` fails for new fields.
- [ ] **Step 3: Extend** API extraction, URL/query fallback, flat designer mapping, renderer type, and token choices. Use existing `formatNumericRange` and string helpers; show canonical temperature choices but retain legacy aliases for saved templates.
- [ ] **Step 4: Verify green:** label contract and filament label-data tests pass.
- [ ] **Step 5: Commit** only Task 2 files.

### Task 3: Spool-Owned Tokens and App Currency

**Files:** Modify `frontend/src/lib/spool-label-data.ts`, `frontend/src/lib/label-designer.ts`, `frontend/src/lib/label-template.ts`, `frontend/src/lib/label-token-catalog.ts`, `frontend/src/pages/spools/[id]/print.astro`, `frontend/src/pages/spools/print.astro`, `frontend/src/lib/spool-label-data.test.ts`, and `frontend/src/lib/label-token-contract.test.ts`.

**Interfaces:** Add `{spool_material}`, `{spool_outer_diameter_mm}`, `{spool_width_mm}`, `{rfid_uid_2}`, and `{purchase_currency}`. Extend `buildSpoolLabelDataFromApi(spool, lookups, fallbackId, purchaseCurrency = '')`, `buildSpoolPrintSearchParams(spool, lookups, purchaseCurrency = '')`, and `buildSpoolDataFromApiSpool(spool, lookups, fieldDefs, purchaseCurrency = '')`; print pages pass `getCurrency()` after loading settings. Preserve effective-value fallbacks for existing `{filament.spool_*}` tokens.

- [ ] **Step 1: Write failing tests** for direct spool values, product/manufacturer fallback, primary and secondary RFID independently, explicit app currency, old token aliases, and query-fallback parity.
- [ ] **Step 2: Verify red:** `cd frontend && npx vitest run src/lib/spool-label-data.test.ts src/lib/label-token-contract.test.ts` fails for missing tokens.
- [ ] **Step 3: Extend** canonical data, query params, designer mapping, renderer type, and token catalog; pass the configured currency from single and batch print routes. Do not add a database column or modify the currently dirty spool detail page.
- [ ] **Step 4: Verify green:** focused label tests pass, including single/batch representative data.
- [ ] **Step 5: Commit** only Task 3 files.

### Task 4: Collapsible, Searchable Token Dock Without Premature Scroll

**Files:** Modify `frontend/src/components/freeform-label/FieldDock.astro`, `frontend/src/lib/freeform-label/field-drawer.ts`, `frontend/src/lib/label-extra-fields.ts`, `frontend/src/lib/freeform-label/built-in-fields.dom.test.ts`, `frontend/src/lib/freeform-label/field-drawer.dom.test.ts`, relevant extra-field picker tests, and needed `frontend/src/i18n/{en,de,fr}.json` entries.

**Interfaces:** Use `LabelTokenChoice.section` values `identity`, `material`, `packaging`, `temperatures`, `drying`, `print_behavior`, `compatibility` for filament choices and `inventory`, `physical`, `purchase`, `identity`, `lifecycle` for spool choices. Render native `<details open>` groups with compact existing chips. One `type="search"` input filters visible chips by label or token; groups without matches hide, and clearing restores independent pre-search open states. Existing token insertion and tab behavior stay unchanged.

- [ ] **Step 1: Write failing DOM tests** for correct functional group names and all old/new tokens (old order need not remain), independent collapse, search showing matches across groups, prior-state restoration on clear, no-match behavior, tab switching, and keyboard focus.
- [ ] **Step 2: Verify red:** `cd frontend && npx vitest run src/lib/freeform-label/built-in-fields.dom.test.ts src/lib/freeform-label/field-drawer.dom.test.ts src/lib/freeform-label/extra-field-picker.dom.test.ts` fails for missing groups/search.
- [ ] **Step 3: Implement** grouped markup and dynamic extra-field groups, localized labels, and a small dock-local search binding. Remove the 280px dock cap and inner scrolling so `.freeform-canvas-region` owns overflow. Do not enlarge token chips or add a results panel.
- [ ] **Step 4: Verify green:** focused DOM tests pass; `npm run check:editor-workspace` passes against a running local frontend at tall, short, and narrow viewports, including all four print routes.
- [ ] **Step 5: Commit** only Task 4 files.

### Task 5: Branch and PR Verification

**Files:** No product files; update the existing PR description after code verification.

- [ ] **Step 1: Run** focused label and currency tests, `npm run check`, and `npm run build`; record any unrelated baseline failures separately.
- [ ] **Step 2: Review** the branch diff for token spelling, saved-template compatibility, user-owned unstaged edits, and app-currency display.
- [ ] **Step 3: Push** the verified branch without force; stop and re-evaluate if its remote has advanced.
- [ ] **Step 4: Update** PR #182's existing body (preserving its other text) with separate spool and filament tables: pre/post native existence, pre/post detail/edit visibility, type/units, source, owner, and now-working tokens. Distinguish linked filament data shown on a spool page from spool-owned fields.
- [ ] **Step 5: Read back** the PR body and report the URL plus test results to the user for review.
