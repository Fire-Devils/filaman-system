# UI design standard

Use the existing filament/spool detail pages and shared compact forms as the reference. Extend the shared components rather than introducing a page-specific visual language. Apply these defaults to new and touched core UI; existing pages are not all migrated. Plugins retain their own behavior and may reuse the same components/styles.

## Page structure

| Surface | Pattern |
| --- | --- |
| Full-page list | Plain title and compact actions above the table (`.fm-list-toolbar`; `AdminHeader` on Admin pages). Softly contrasting column headers (`--bg-soft`), a bottom rule and bare row-action icons. Add filter/sort controls where useful. No tinted page-title strip. |
| Bounded content section | `FormSection`: softly tinted heading (`--bg-soft`), body (`--bg-elevated`), shared border and radius. Keep nested subsections lighter: a small heading and divider, not another full card. |
| Settings form | Bounded readable width; use shared row layout. Use the same plain title and action row as full-page lists, without a separate Settings header style. Save reflects actual changes. |
| Complex create/edit form | `FormDialog` with title and Save/Cancel in its sticky header. Desktop popup; full-screen on small screens. |
| Simple record metadata | In-place edit with explicit Save/Cancel. Keep the record context and field order, retain the draft after failure, and return focus on cancellation. |
| Dashboard | Styling changes preserve existing fields and grouping unless a layout change is explicitly approved. Apply the shared type, borders and spacing; color communicates status. |

## Layout and density

- Standard content width: up to **1110px**, aligned toward the sidebar. Compact forms and long reading content: up to **48rem**. Wide data tables may use the available width.
- Align list titles to the normal content edge. Optional Back-to-parent links sit above the title (`AdminHeader`), not in an outlined icon button beside it.
- Keep small metadata editors compact within their section, rather than stretching inputs to the page edge; the Role Name/Description editor uses **32rem** maximum width.
- Use responsive columns when space permits, then stack. Reduce outer gutters on small screens; do not shrink text to fit.
- Section header padding: **12px 16px**; body padding: **16px**; section gap: **16px**. Form row gap: **14px**. Reuse shared classes so future adjustments apply everywhere.
- Put explanations beneath their associated controls, not beneath the label column.
- Keep related values close to their labels. Short numeric inputs should not fill a wide column. Units sit beside the value/input; range endpoints use matching widths.
- Avoid nested fixed-height scroll areas. Group long permission lists into responsive columns. The page/dialog may scroll when its content exceeds the viewport; do not promise a no-scroll layout at every size.
- Sidebar progression: full sidebar, collapsible icon rail, then hamburger at small widths. Keep mobile navigation clear of persistent page actions.
- Where a long form needs persistent Save actions, keep the ordinary page heading and actions sticky within the actual scrolling container. Keep them clear of the mobile hamburger and focused fields; do not introduce a separate rounded or tinted Settings title panel.

## Color, typography and icons

- Use the existing theme variables for backgrounds, text, muted text, borders, accent, success, warning and error. Verify Default, Light and Dark; avoid hardcoded white surfaces.
- Page titles use the existing serif face. Section headings, labels and values use the UI face. Technical keys/identifiers may use monospace.
- Muted means secondary or unavailable information; an empty value is a muted dash. Do not show empty input-shaped boxes in read mode.
- Use the existing icon set. Pencil = Edit, overlapping sheets = Duplicate, trash = Delete, puzzle = Plugin, printer = Print. Keep matching icons at the same optical size.
- Admin navigation tiles use a **22px** decorative icon beside each title, with consistent placement and theme-inherited color. Keep the text label; do not add circular button backgrounds to these icons.
- Table Edit/Delete actions use `tableAction`: **24px** targets with **18px** icons, no permanent circular background. Preserve focus outlines, translated accessible names and tooltips. Other controls use their established larger targets; never compress mobile controls until they overlap.
- Table column headings use a visibly distinct soft surface against the table body in every theme, including lighter headings in Dark and Default. Bounded section headings also use `--bg-soft`; page titles remain plain. Status pills use color with a readable label; color alone never communicates a state.

## Editing and feedback

- Use `bindFormState` where appropriate: unchanged/reverted = muted disabled Save; changed = accent enabled Save; saving = disabled/busy; failure = retain draft and permit retry. A successful save establishes a new baseline.
- Establish the baseline after loading the record. Reverting an optional control must also normalize its hidden helper values; hidden opacity values must not leave an unchanged color dirty. Keep native and server validation separate from dirty-state tracking.
- Action buttons such as Install, Restore, Confirm and Copy are enabled by readiness/validation, not by a dirty-form comparison.
- Use `bindFormDialog` for native focus containment and focus return. While a write is pending, block Cancel, Escape, backdrop dismissal, reopening and competing submissions; restore controls after failure. Retain one-time secrets in their dedicated disclosure flow, never in a table.
- Hidden editors, actions and conditional fields must remain invisible and outside keyboard navigation even when shared styles set `display: grid` or `flex`. Check computed visibility, not just the presence of a `hidden` class.
- Present normal results as inline status messages; genuine failures use an error message with useful server detail. Do not title successful update checks “Error.”
- Read-only plugin-owned data gets a visible owner/explanation and a link to the relevant plugin management surface. Do not rely only on a lock icon or hover tooltip, and do not bypass server-side ownership rules.
- Share the surrounding core layout while plugins retain ownership of their configuration, validation and save handlers.
- Role and permission editing must retain system-role protections and authorization. Group permissions by their existing category; keep the role being edited visible.

## Tables and validation

- Reuse column filter/sort helpers. Filtering paginated records must apply to the complete dataset before pagination and counts, with deterministic ordering.
- Keep a column's heading, sort button and filter button on one line. The search/action toolbar may wrap when needed; wide tables should scroll inside their own container (`.fm-table-scroll`), without widening the whole page or clipping columns.
- Preserve existing routes, request/response shapes, empty-secret behavior and backend validation when changing presentation.
- Verify loading, empty, populated, unchanged, changed, reverted, saving and failed states. Check keyboard operation, hidden controls, long translated labels, desktop/tablet/mobile layouts and the three themes. Confirm sticky actions remain reachable after scrolling.
- Capture real before/after screenshots at matching viewport/data/theme states. Mark evidence pending when browser access is unavailable; do not present old screenshots as the current code.
