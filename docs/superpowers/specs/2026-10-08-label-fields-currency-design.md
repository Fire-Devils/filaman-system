# Label Fields, Currency, and Token Dock Design

## Goal

Make every new standard filament field usable in label templates, make spool-specific label fields unambiguous, and organize the label editor's field picker without wasting available preview height. Preserve the distinction between a filament product and one purchased physical spool.

## Decisions

- Purchase totals use one configured application currency. Do not add a per-spool currency database column or exchange-rate conversion.
- A new spool may prefill its editable purchase price from its filament's reference price only when the filament currency is absent or matches the application currency. A declared mismatch leaves the purchase-price input blank.
- Filament packaging fields are product defaults; corresponding spool fields describe that physical spool. Keep both and explain their roles in the PR field tables.
- Existing saved label templates and token spellings remain valid.

## Scope

In scope: filament and spool label-token data, the shared freeform label field dock, the new-spool price suggestion, focused tests, and a revised field/accounting section in the existing PR description.

Out of scope: database migrations, per-purchase currencies, currency conversion, moving fields between filament and spool, redesigning the reduced standard-label checkbox editor, and changing how Spoolman imports prices when its source supplies no currency.

## Label Data Contract

Add picker-visible `{filament.<native_field>}` tokens for the 17 filament fields added by this PR. Range values render as a human-readable minimum–maximum; list values join with commas; booleans render as yes/no. Numeric tokens remain unitless values so a template can choose its own unit presentation. `{filament.price_currency}` renders its stored currency code. Keep the legacy extruder/bed temperature token aliases renderable in saved templates, but show only their canonical new names in the picker to avoid duplicate-looking buttons.

For spools, add direct `{spool_material}`, `{spool_outer_diameter_mm}`, `{spool_width_mm}`, and `{rfid_uid_2}` tokens. The existing `{filament.spool_*}` tokens continue to resolve effective spool values on spool labels, so older templates do not break. A `{purchase_currency}` token provides the configured application currency without storing currency on each spool.

Populate tokens through the existing API → flat label data → designer data → template renderer path, including URL/query fallback and single/batch print paths. A token must be renderable, not merely listed as a button. Empty source values render empty as existing label fields do.

## Field Dock

Keep the existing Filament and Spool tabs. Within each, render compact native collapsible groups using the same conceptual sections as the detail pages:

- Filament: identity/color, material, packaging, temperatures, drying, print behavior, compatibility/sources, extra fields.
- Spool: inventory, physical spool, purchase, identity/RFID, lifecycle, extra fields.

All groups start expanded, so the available preview height is useful immediately; users may collapse groups independently. Keep the current small token-chip sizing and visible full-token tooltips. Add one small native search input above the groups as a trial: it filters by display name or token spelling, temporarily reveals groups with matches, and restores prior collapse states when cleared. No separate results view or persistence is needed.

Remove the dock's fixed 280px height cap and its independent premature scrolling. The existing preview workspace scrolls when the expanded content genuinely exceeds its available height. Preserve keyboard access and focus visibility for tabs, group summaries, search, and token buttons. Check short and tall viewports, narrow layouts, and both filament and spool print pages.

## PR Field Tables

Update the existing PR description after implementation with separate spool and filament tables. Each row (or clearly named field group) records: standard field/token name, type and unit, whether it existed before the PR, detail/edit visibility before and after, source (manual, Spoolman, or FilaManDB when available), intended owner, and actual label-token coverage. Explain that the spool detail page also displays linked filament fields and that dynamic Spoolman extras are source-defined rather than a fixed set of standard columns.

## Verification

- Focused tests prove every new token resolves a representative value on filament and spool labels, including absent values, ranges, lists, boolean false, spool overrides, second RFID, and application currency.
- DOM tests prove token groups, search, and existing token insertion work without breaking saved-template aliases.
- A focused check proves a mismatched filament currency does not prefill a new spool's purchase price; matching or absent currency still does.
- Run frontend type/build checks and inspect the expanded dock at short, tall, and narrow viewport sizes. Update the PR body only after these checks pass.
