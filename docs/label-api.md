# Label rendering and print-request API

Any device or client can use this API to render a spool or filament label.
Both label types also support asking a signed-in FilaMan browser session to open
a label for printing or PDF export.

## Authentication

Create a **user API key** with `spools:read` for spool labels or
`filaments:read` for filament labels and send it with every request:

```http
Authorization: ApiKey <key>
```

A device token with the corresponding read scope can render the Default label, but it cannot
list or use a user's saved presets or request printing in that user's browser.
Keep credentials out of logs and browser code.

## Presets

List the API key owner's saved spool-label presets:

```http
GET /api/v1/labels/presets
```

For filament-label presets, use `GET /api/v1/labels/presets?preset_type=filament`
with `filaments:read`. The omitted `preset_type` defaults to `spool` and requires
`spools:read`; the response shape is identical for both types.

Example response:

```json
[{"id": 7, "name": "40 mm spool", "selected": true, "width_mm": 40, "height_mm": 30}]
```

Dimensions use the same rules as rendering, so clients can filter presets for
the loaded label roll. Both dimensions are `null` if the saved dimension data
is invalid; this does not hide the preset from the list.

Select a preset for the user:

```http
PUT /api/v1/me/label-presets/selection
Content-Type: application/json

{"preset_id": 42}
```

Send `{"preset_id": null}` to select Default. Success returns `204 No Content`.
Omitting `preset_type` keeps the existing spool behavior and requires `spools:read`.
For filament selection, send `{"preset_id": 8, "preset_type": "filament"}` with
`filaments:read`; send `{"preset_id": null, "preset_type": "filament"}` for Default.
The preset must exist, belong to the user, and match the requested type.
Spool and filament selections are independent: changing or clearing one never
changes the other. Loading or saving an owned preset in either designer updates
that type's API selection; loading a built-in or cross-type preset selects Default
for the current type instead.

On render and print requests:

- Omit `preset_id` to use the user's selected preset, or Default if none is selected.
- Send `preset_id=0` to use Default without changing the user's selection.
- Send a positive ID to use that saved preset.

Rendering accepts only presets of the requested label type owned by the API key
user. A spool preset on the filament route, a filament preset on the spool route,
or another user's preset returns `404`.

Preset IDs can disappear when users delete presets, so clients should refresh
the list after a preset returns `404`.

## Render a label

```http
GET /api/v1/labels/spool/123/render?format=mono1&width=576&dpi=203&align=right&preset_id=7
Authorization: ApiKey <key>
```

Render a filament without creating a spool:

```http
GET /api/v1/labels/filament/123/render?format=png&width=576&preset_id=0
Authorization: ApiKey <key>
```

Both routes use the same parameters, output formats, sizing rules, renderer
options, and headers below. Filament labels use filament fields and typed
`extra.filament.*` values; `{id}` and `{filament.id}` identify the filament.
Their QR codes link to `/filaments/{id}` (including when a saved QR uses a
custom base URL). Spool-only fields are empty. Filament Default is 60 × 40 mm
and omits remaining spool weight. Spool print requests remain spool-only.

Supported query parameters:

| Parameter | Values |
| --- | --- |
| `format` | `png` (default) or `mono1` |
| `width` | Output width from 384 to 1024 pixels |
| `dpi` | Optional physical resolution from 100 to 600 DPI |
| `align` | `left` (default) or `right` |
| `orientation` | `original` (default), `portrait`, or `landscape` |
| `preset_id` | Omitted, `0`, or a saved preset ID |
| `color` | `mono` (default) or `color`; color requires PNG |
| `threshold` | Integer 0–255; default `200`; mono1 only, ignored for PNG |

With `dpi`, FilaMan renders the preset at its physical size and pads it to the
requested width. Without `dpi`, the label fills the requested width and its
height follows the design's aspect ratio. A label that cannot fit returns `422`.

### PNG response

`format=png` returns `image/png`. Use `color=color` to preserve colors in
swatches, logos, and uploaded images.

### One-bit response

`format=mono1` returns `application/octet-stream` with one bit per pixel. Rows
are top-to-bottom, start on byte boundaries, and use most-significant-bit first;
`1` means black. Unused low bits at the end of a row are zero.

Monochrome conversion uses a plain threshold, not dithering: grayscale values
strictly below `threshold` become black. The default is `200`; an explicit
`threshold` overrides it, including `0`. Tune it for your printer and stock;
the default is not a universal print-quality guarantee. The byte layout is unchanged.

For mono1, SVG uses undecorated QR codes with error correction M,
a four-module white quiet zone, and at least three whole printer dots per module. Saved logo
or center-text QR modes are overridden for this response only. Codes retain
their URL and layout slot; insufficient space or clipping at the label edge
returns `422`. A module is one square in the QR grid: three dots per module
means each square occupies a 3×3 printer-dot block (about 0.38 mm wide at
203 DPI). Minimum box width is `(module count + 8) × 3` pixels, including
the quiet zone; longer URLs may need more modules and a larger box. A too-small
box returns a QR size error. This conservative
thermal limit is not a scan guarantee. PNG and normal browser printing keep
the saved QR styling and are not subject to this three-dot minimum.

Read these response headers before passing the raster to device-specific code:

- `X-Image-Width`, `X-Image-Height`, and `X-Row-Bytes`
- `X-Bit-Order: msb-black-1`
- `X-Content-Width` and `X-Rotated`
- `X-Preset-Id` (`0` means Default)

Validate that the body length equals `X-Row-Bytes * X-Image-Height`. The body is
a raster, not printer commands.

All render responses, including errors, include `Cache-Control: no-store`.

## Shared SVG rendering

Labels use the shared SVG renderer. It shares font metrics,
wrapping, fitting, geometry and rasterization with the designer's WASM preview
and 600-DPI exports. It supports all four bundled font families, inline styles,
images/logos, shapes and umlauts. Text that cannot fit at the configured minimum
returns `422`; enable **Scale font to fit** or enlarge its box. No silent fallback
to another renderer occurs. Existing V2 presets and migrated V1 presets are reused;
the preset format is V2. Normal QR styling remains separate from mono1.

The source-built image includes Node 20, the standalone command, fonts/WASM and
licenses, without a server browser. Source installations must build the frontend
(or run `npm run build:label-svg` from `frontend`) and install Node 20.
`LABEL_RENDER_NODE_EXECUTABLE` and `LABEL_RENDER_SVG_DIR` select the executable
and bundle directory. There is no renderer query parameter or selection setting. Containers run the command
as the unprivileged `LABEL_RENDER_USER=label-render`. The command reads one JSON
request through stdin and has no HTTP listener or request-controlled URL fetching.
It starts a fresh process per request, with a 30-second deadline and bounded I/O.
See [label rendering checks](../frontend/tests/label-rendering/README.md) for
development tests that compare browser output and API bytes. Physical print
quality and QR scanning require testing on the target printer.

When `preset_id` is omitted, the
user's selected preset determines the label dimensions; Default is used only
when no preset is selected. Designer presets (including automatically migrated V1) use V2
dimensions. Field values remain literal: formatting markers only take effect
when written in the template. Native wrapped text breaks long identifiers;
migrated information keeps legacy word wrapping. Missing logos and empty/fitted
legacy titles collapse their rows. Enable **Scale font to fit** to shrink text
down to its configured minimum; wrapping alone does not enable shrinking.
Label dates do not depend on the browser/container locale or timezone. Purchase
dates and Standard Label date-only fields use `YYYY/MM/DD`. Unmodified datetime
tokens, including custom and system extra fields, retain the stored timestamp
with its time, precision and timezone offset; no local-time conversion is applied.
Date-only modifiers are consistent across editor and API: `{created_at|date}` prints
`2026/04/28`, independently of the container/browser locale. Customize the order
and separators with `{created_at|date:%d.%m.%Y}` (`28.04.2026`),
`{created_at|date:%m/%d/%y}` (`04/28/26`), or
`{created_at|date:%Y-%m-%d}` (`2026-04-28`).
Supported codes are `%Y`, `%y`, `%m`, `%d`, and `%%` (a literal percent).
Other codes remain literal. The modifier uses the stored calendar date without
timezone conversion; invalid date values remain visible unchanged.
The same modifiers work with date/datetime extra fields and remove the time.
Use them for compact dates on small labels; the unmodified timestamp can be longer.

To share a preset for troubleshooting, sign in and open
`/api/v1/me/label-presets?preset_type=spool` on the same FilaMan server. Save the
JSON response and share only the affected preset object after checking templates
for private URLs or text. There is no dedicated preset-export button. Uploaded
images are referenced by ID and are not embedded in this response; a full backup
is not needed for a text-layout report. Never send session cookies or API keys.

For v2 designs, QR elements render above non-QR content with opaque white
backgrounds, regardless of their saved layer positions.
The designer and PNG/normal print output add an automatic
four-module white outline outside the QR's size handles. It can occupy the
label margin; the editor warns only when it extends off the physical label.
The `mono1` QR slot includes its quiet zone internally, preserving
the printer-raster sizing contract. The editor provides separate 200/300 DPI
size guidance and a caution for center decoration; neither guarantees scanning.

All API renders share one slot across server workers to bound peak memory. A busy
request returns `503` with `Retry-After: 1`. A missing SVG runtime returns `503`
without a retry hint.

Output is limited to 1024 x 2048 pixels. Uploaded images and QR codes share a
12-megapixel budget, and manufacturer logos are limited to 2 MB. Invalid or
unready designs return `422`.

## Ask a browser to print or export

```http
POST /api/v1/labels/spool/123/print-request?preset_id=7
Authorization: ApiKey <key>
```

The response is:

```http
201 Created
Content-Type: application/json

{"id": 42, "spool_id": 123, "preset_id": 7, "created_at": "2026-10-24T12:00:00Z", "expires_at": "2026-10-24T13:00:00Z"}
```

For a filament label without a spool, use a key with `filaments:read`:

```http
POST /api/v1/labels/filament/123/print-request?preset_id=8
Authorization: ApiKey <key>
```

This returns `201 Created` with `id`, `filament_id`, `preset_id`, `created_at`
and `expires_at`. The spool endpoint requires `spools:read` and returns
`spool_id` instead of `filament_id`. Presets must belong to the key's user
and match the requested type; wrong-type or unowned presets return `404`.

`preset_id` is optional. When omitted, the user's selected preset is resolved
for that label type when the request is queued, with Default as the fallback. Send `preset_id=0` to
request Default explicitly. The request lasts **one hour from submission** and
appears in a FilaMan tab signed in as the API key's user, including when they log
in during that hour. A compact notification shows the rendered label and its size.
The preview fits within 260 × 200 CSS pixels without changing the label's aspect
ratio or printed dimensions. Its age badge appears after one minute, turns red
at 55 minutes, and the notification closes at expiry. A small strip beneath the
card indicates another waiting request; queued labels render only when shown.

**Print** prints that preview at the preset's physical dimensions, using the
browser's saved **Print PDF** preference from the print page. With that preference
off, it opens the system print dialog; with it on, it prepares a PDF and shows a
**Download PDF** link inside the same label card. The preview stays visible until
dismissed or expired; no separate PDF window opens.
The preference is browser-wide, not part of a preset. This prints one individual
label; it does not reuse sheet layouts or batch copy counts. **Edit** opens the
corresponding spool or filament print page. The red trash button dismisses only
the request. Each action claims the request so another tab cannot process it.
Browser print jobs share a busy guard: if another label is printing, finish or
close its dialog and retry. The current request remains available.
A `201` confirms queueing, not physical printing. Cancelling a print dialog does
not requeue the request.

Unsupported preset data is rejected with `422` before queueing. The browser refreshes
an explicitly requested preset from the server. If that refresh fails or the preset
is unavailable, printing and export are blocked; FilaMan does not use a stale cached
copy or substitute Standard. The requested spool or filament must also load
successfully, including for Default labels. If it is unavailable, printing and
export stay blocked; reload the page to retry. Automatic tab selection does not change the
user's saved workspace tab.
Opening an explicitly requested preset also leaves the browser's working designer
draft intact, including while editing the one-off label. A normal print-page visit
returns to that draft. Explicitly loading another preset through the editor resumes
normal draft saving; automatic request loading never changes the account selection.

These endpoints are used by FilaMan's browser UI; device clients do not need to
call them directly:

```text
GET  /api/v1/labels/print-requests/pending
GET  /api/v1/labels/print-requests/{id}/preview
POST /api/v1/labels/print-requests/{id}/claim
```

Pending returns the oldest unexpired request owned by the signed-in user that
their permissions allow, or `null`. Its `has_more` flag indicates another
unexpired request available to the same user and permissions. A request contains either `spool_id` or
`filament_id`, never both. Claiming requires the corresponding read permission
and consumes the request exactly once (`204`); an expired, missing, already
claimed, unowned, or inaccessible request returns `409`. Neither scope returns
`403`. Clients scoped only to `spools:read` never receive filament requests.

Preview requires the same ownership, expiry and entity read permission checks.
It returns a color PNG at 600 DPI, without thermal-printer padding, and
`X-Label-Width-Mm` / `X-Label-Height-Mm` headers for physical output size.
It does not consume the request. Outputs above eight megapixels return `422`,
matching the editor's print-resolution limit. The browser renders once per
request and uses the same pixels for its preview and print/PDF output.

## Errors

- `401`: check the API key.
- `403`: check the scope or user-key requirement.
- `404`: refresh the spool, filament, or preset.
- `422`: correct the parameters or label design.
- `503`: the renderer is busy or unavailable; honor `Retry-After` when present.

Do not automatically retry print requests because duplicates can create
multiple prompts.

## Device integration example

A 203-DPI monochrome printer client can request `format=mono1&dpi=203`, validate
the response headers and body length, then hand the raster to its own printer
transport. Printer discovery, connection setup, command encoding, and transfer
are device concerns and are intentionally outside this API.

Projects such as [SpoolmanScale](https://github.com/Niko11111/SpoolmanScale)
and [myphomemo](https://github.com/DeepCoreSystem/myphomemo) are examples of
device-side integration; they do not define the API contract.
# Designer preset compatibility

Saved extra-field tokens for promoted standard fields follow the native value,
retaining their original units, precision and checkbox symbols. These compatibility
aliases do not appear as new token choices.

Upgrades automatically convert supported legacy V1 designer presets to V2 in
place. IDs, selection, ownership and timestamps remain unchanged. Saving old
presets, importing browser presets, and restoring JSON/JSONL backups use the same
conversion. Designer rendering uses V2; Standard labels and sheet presets
remain separate, with shared SVG rendering.

The original settings remain in `legacy_v1` for recovery, not rendering. Unknown,
malformed or over-budget presets are preserved, with null dimensions in listings
and an actionable 422 when rendered. Reopen and save those in the Label Designer.
Downgrading does not overwrite subsequent V2 edits; restore a pre-upgrade backup
for an exact rollback. The mono1 byte format and thermal QR rules are unchanged.
