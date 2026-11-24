# Plugin UI Launchers Reference

This document describes the plugin UI launcher capability for FilaMan, enabling plugins to request buttons in supported host locations.

## Manifest Schema

Explicit launcher packages must bundle `page.html` at the package root; incomplete upgrades are rejected before replacing the installed version. Missing installed pages are omitted from explicit discovery.

Plugins declare launchers using the optional `capabilities.ui_launchers` array (at most 16 entries). Each entry is an object with these fields:

- `id`: Unique within the plugin, 1–50 characters matching `[a-z0-9][a-z0-9_-]*`.
- `surface`: A bounded name, at most 80 characters. Unknown future surfaces are retained but not mounted on this host.
- `label`: Nonblank plain text, maximum 80 characters.
- `modes`: Required for editor surfaces; a nonempty unique subset of `"create"` and `"edit"`.

### Example: `colors.editor` Surface

```json
{
  "id": "research-color",
  "surface": "colors.editor",
  "label": "Research color",
  "modes": ["create", "edit"]
}
```

## Supported Surfaces

Five locations are mounted by this PR:

- `filaments.editor`
- `colors.editor`
- `filaments.library`
- `colors.library`
- `filaments.selection`

The `colors.selection` declaration and generic context contract are recognized, but its native selection controls and UI mount belong to color-library PR #292. This PR does not add color cleanup, selection controls, color-picker changes, or database migrations.

Unknown future surfaces are ignored by discovery.

## Modes and Permissions

- Editor surfaces (`*.editor`) require `modes`.
- Library/selection surfaces do not accept `modes`.
- Filament editors require `filaments:create` or `filaments:update`; color editors require `colors:create` or `colors:update`. Selection surfaces require the corresponding update permission. Library discovery requires existing authenticated library access. Every plugin API still enforces its own authorization.
- Editor launchers require unique modes; invalid entries are rejected.

## Legacy Fallback

Keep legacy `filament_ui.editor`/`selection` declarations for older hosts. Legacy create-mode buttons retain their text presentation; `editor_launcher` icon/auto-open metadata is applied only in edit mode. On a new host, valid explicit entries replace legacy entries for the same surface and requested mode. An Edit-only declaration leaves legacy Create support available. Only legacy editor entries retain existing user-enabled auto-open behavior; new entries require an explicit click.

## Host-Owned Ordering and Drawers

- Launchers appear in host-controlled locations.
- Native actions stay in their existing order.
- Up to three plugin icon buttons are shown; extras go in a "More" menu.
- Drawer behavior is reused: preferred width 560px, minimum 384px.

## Discovery Endpoint

GET `/api/v1/plugin-ui-launchers?surface=<surface>&mode=<create|edit>`

- Returns validated launcher identity, label, plugin name, page URL, and icon URL.
- Mode required for editor surfaces; rejected for library/selection.
- Malformed persisted entries are skipped individually; runtime discovery examines at most the first 16 entries and keeps the first valid declaration for each ID. Malformed declarations do not suppress legacy entries. Ambiguous installed page claims are omitted rather than opening the wrong package.

## Context and Protocol

### Generic Version 1 Library/Selection Context

New-style launchers use `filaman:launcher-context`:

```json
{
  "type": "filaman:launcher-context",
  "request_id": "abc123",
  "version": 1
}
```

Library replies echo `type`, `request_id`, `version: 1` and identify `launcher_id`, `surface` and `context`. For example:

```json
{"type":"filaman:launcher-context","request_id":"abc123","version":1,"launcher_id":"review-colors","surface":"colors.library","context":{"entity":"colors"}}
```

Selection contexts are `{color_ids: [11, 12]}` or `{filament_ids: [10], expected_filaments: [...]}` using the existing filament selection snapshot. They are captured at opening; later table changes never retarget the open tool. Select all matching works only after the complete selection resolves to explicit IDs. Library context includes no draft, filter or inventory dump. Editors use their entity-specific protocol instead of this generic context request.

### Color Editor Protocol

The host opens the installed page with `color_host=editor`. New entries also receive their validated `launcher_id`; never infer staging authority from query parameters alone. Requests require a nonempty `request_id` of at most 128 characters and must come from the active iframe document.

```json
{"type":"filaman:color-context","request_id":"read-1"}
```

The reply echoes type/request_id and contains `{mode, color_id, usage_count, fields: {name, hex_code}, capabilities: {color_staging: true}}`. Require the capability before offering form staging. A null color ID denotes a new unsaved color. Here, `usage_count` counts distinct filaments sharing the edited swatch. The existing color-list endpoint retains its assignment-row count; one filament can contain multiple positions referencing the same swatch. These are different units.

```json
{"type":"filaman:color-stage","request_id":"stage-1","expected":{"name":"My red","hex_code":"#FF000080"},"fields":{"name":"Traffic red (RAL 3020)","hex_code":"#AB1519"}}
```

Each field object contains exactly Name and HEX. Names are trimmed, nonblank and at most 100 characters. Expected fields must match the captured and current draft. Only RGB changes: existing native opacity is retained even when the proposal includes alpha. Successful replies echo type/request_id with `staged: ["name", "hex_code"]`, `skipped: []` and actual resulting `fields` (including preserved alpha). Rejection returns `staged: []`, `skipped: ["name", "hex_code"]`. No inventory write occurs; the user reviews and clicks native Save. Staging is blocked while saving; a failed Save retains the open tool and its conversation. Native edits and Save invalidate earlier staging context; request fresh context before staging again. Accepted color-stage replies can be chained using their returned fields. Staging has a 2.5-second budget including server eligibility checks; Open existing allows human-time confirmation and rechecks authorization afterward.

`{type: "filaman:color-open", request_id: "open-1", color_id: 11}` requests opening an existing native swatch form. The host checks dirty-state confirmation; allow human time instead of the usual short message timeout. Cancellation replies `opened: false`. Success disposes the old iframe/session and opens the requested form. This never merges colors or reassigns filament links.

### Filament Editor Protocol

- Context: `filaman:filament-context`
- Stage: `filaman:filament-stage`

## Capability Detection and Fallback

- A missing discovery route, unsupported context version or absent staging capability disables only that integration. Keep the ordinary plugin page and legacy filament functionality working on older hosts.
- Plugins without new declarations continue to use legacy behavior.
- No automatic migration of plugin packages.

## Plugin Page Ownership

- Launchers require explicit page ownership.
- External URLs, traversal, fragments, and cross-plugin paths are rejected.
- Existing legacy mappings retain their accepted paths for compatibility; new explicit entries require the plugin’s own namespace.

## Lifecycle Protections

- Mount only registered installed plugin pages.
- Bind messages to active iframe window, exact origin/path, current Document, and request ID.
- Create new context session per opening/record transition.
- Cancel pending staging on close, abort, or record switch.
- One active tool per host workspace; replacing an open conversation requires explicit confirmation. Same-path reload invalidates the old session; reopen the tool to obtain fresh context.

## Drawer Behavior

- Reuse existing drawer with preferred width 560px, minimum 384px.
- Dock only when the actual workspace fits a 600px host form, 384px drawer and 16px gap; otherwise use a native modal. Resizing retains the iframe and conversation.
- Preserve focus, Escape, scrolling, and mobile accessibility.
- Selection tools may reuse larger selection dialog; plugins do not choose positioning.

## Icon Support

Plugins may declare an optional SVG icon in `plugin.json`:

```json
{
  "icon": "icon.svg"
}
```

Icons are validated during install/upgrade. Fallback is a puzzle icon.

## Complete manifest example

```json
{
  "plugin_key": "my_tools",
  "name": "My tools",
  "version": "1.0.0",
  "description": "Research and review colors.",
  "author": "Plugin author",
  "plugin_type": "integration",
  "page_url": "/plugin-page/my_tools",
  "icon": "icon.svg",
  "capabilities": {
    "ui_launchers": [{"id":"find-color","surface":"colors.editor","label":"Find color","modes":["create","edit"]}],
    "filament_ui": {"editor":true,"selection":true,"editor_launcher":{"style":"icon","allow_auto_open":false}}
  }
}
```

See [Plugin icons](plugin-icons.md) for SVG restrictions and legacy auto-open preferences. New declarations accept no URL, HTML, CSS, scripts, priority, executable visibility expression or permission override. FilaMan uses the installed page and validated plugin icon.

## Trust boundary

Launchers define supported UI integration for trusted installed plugins. Same-origin iframe scripts and backend plugins are not isolated by this contract; button visibility does not revoke their existing API authority. There is no generic mutation bridge. Research, models and conversation persistence stay plugin-owned; host adapters own form validation and native Save.
