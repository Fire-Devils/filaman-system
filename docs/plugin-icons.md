# Plugin Icon Developer Guide

## Overview

Plugins may declare an optional SVG icon in `plugin.json` using a relative path. The icon is validated during install and upgrade. Icons are served via `/api/v1/plugin-icons/{plugin_key}`.

## Declaration and Validation

Add the optional field alongside your plugin’s existing manifest fields:

```json
{ "icon": "icon.svg" }
```
- In `plugin.json`, the `icon` field specifies a relative path to an SVG file (e.g., `"icon.svg"`).
- If `null` or omitted, a puzzle icon is used as fallback.
- During install or upgrade, the host validates the icon before copying it into the plugin package.
- If an upgrade omits the `icon` field, the stored icon is cleared.

## Icon Requirements

- Must be a UTF-8 SVG file with a maximum size of 4 KiB.
- Must not contain:
  - DOCTYPE declarations
  - Entity declarations, stylesheet processing instructions, or comments
  - Script elements
  - Remote or inline references (e.g., `href`, `xlink:href`)
  - Gradients, patterns, or filters
  - CSS styles or `<style>` tags
  - Foreign objects
- Supported SVG elements: `svg`, `g`, `path`, `rect`, `circle`, `ellipse`, `line`, `polyline`, `polygon`, `title`, `desc`.
- Supported attributes: `viewBox`, `width`, `height`, `fill`, `stroke`, `stroke-width`, and others listed in source.
- Paths must be relative, within the plugin package, and not contain `..`, `.`, or empty path components. Nested paths such as `assets/icon.svg` are supported.

## API Exposure

- APIs `/api/v1/plugin-nav` and `/api/v1/admin/system/plugins` expose `icon_url`.
- The URL is formatted as `/api/v1/plugin-icons/{plugin_key}?v={version}`.
- Icons for inactive plugins are still served.

## Serving Icons

- Authenticated GET to `/api/v1/plugin-icons/{plugin_key}` returns the declared SVG.
- Built-in icons are stored in `backend/app/plugin_icons/{key}/icon.svg`.
- Invalid or missing icons return 404.
- Icons are revalidated on each request. Responses use `Cache-Control: private, no-cache`; the URL includes the plugin version.

## Packaging

- Include icon files in plugin ZIPs with `.svg` extension.
- Older host versions reject ZIPs containing `.svg` files.
- Update packaging extension allow lists to support new features.
- Release a new version of the plugin after host core support is available.

Use a square `viewBox` (24 × 24 works well); FilaMan displays the asset at 22 × 22 pixels. Draw a single-color silhouette with transparent cutouts, using `currentColor` for fills or strokes. FilaMan uses the SVG's alpha channel as a mask and applies the same muted and hover/active colors as its other navigation icons. Embedded colors are ignored, and opaque white backgrounds would become solid blocks.

Prefer a recognizable project mark when one exists, simplifying small details for the 22 px size. Related integrations can share that mark with a small functional overlay, such as an arrow for usage tracking.

The Spoolman import glyph adapts the reel geometry from [Spoolman's published monochrome mark](https://github.com/Donkie/Spoolman/blob/master/client/icons/spoolman_monochrome.svg), flattened to self-contained paths. Its copyright and full MIT notice are [bundled with the asset](../backend/app/plugin_icons/spoolman_import/THIRD_PARTY_NOTICES.txt). Project names and marks identify their respective integrations.

## Fallback Behavior

- If no icon is declared or loading fails, a puzzle icon is displayed in the sidebar, admin plugin list, and plugin details dialog.
- Catalog cards reuse an installed plugin's icon when available. Uninstalled plugins show the puzzle icon.

## Example SVG

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">
  <circle cx="12" cy="12" r="8" fill="currentColor"/>
</svg>
```
