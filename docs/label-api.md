# Label rendering and print-request API

Any device or client can use this API to render a spool label or ask a signed-in
FilaMan browser session to open one for printing or PDF export.

## Authentication

Create a **user API key** with `spools:read` scope and send it with every request:

```http
Authorization: ApiKey <key>
```

A device token with `spools:read` can render the Default label, but it cannot
list or use a user's saved presets or request printing in that user's browser.
Keep credentials out of logs and browser code.

## Presets

List the API key owner's saved spool-label presets:

```http
GET /api/v1/labels/presets
```

Example response:

```json
[{"id": 7, "name": "40 mm spool", "selected": true}]
```

Select a preset for the user:

```http
PUT /api/v1/me/label-presets/selection
Content-Type: application/json

{"preset_id": 42}
```

Send `{"preset_id": null}` to select Default. Success returns `204 No Content`.
The preset must exist, belong to the user, and be a spool-label preset.

On render requests:

- Omit `preset_id` to use the user's selected preset, or Default if none is selected.
- Send `preset_id=0` to use Default without changing the user's selection.
- Send a positive ID to use that saved preset.

Preset IDs can disappear when users delete presets, so clients should refresh
the list after a preset returns `404`.

## Render a label

```http
GET /api/v1/labels/spool/123/render?format=mono1&width=576&dpi=203&align=right&preset_id=7
Authorization: ApiKey <key>
```

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
| `renderer` | `basic` or `chromium` |

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

Read these response headers before passing the raster to device-specific code:

- `X-Image-Width`, `X-Image-Height`, and `X-Row-Bytes`
- `X-Bit-Order: msb-black-1`
- `X-Content-Width` and `X-Rotated`
- `X-Preset-Id` (`0` means Default)

Validate that the body length equals `X-Row-Bytes * X-Image-Height`. The body is
a raster, not printer commands.

All render responses, including errors, include `Cache-Control: no-store`.

## Renderer options

The standard Docker image defaults to `basic`. When `preset_id` is omitted, the
user's selected preset determines the label dimensions; Default is used only
when no preset is selected. Saved v1 and v2 presets are rendered with their
dimensions and a best-effort Pillow implementation of text, tokens, QR codes,
logos, images, swatches, and shapes. Basic does not reproduce custom fonts,
rich text, wrapping, or browser text fitting exactly.

The `-chromium` image defaults to `chromium` and reproduces the editor's saved
presets exactly, including fonts, rich fields, fitting, images, and QR codes.
Start it with the supplied sandbox configuration:

```bash
docker compose -f docker-compose.yml -f docker-compose.chromium.yml up -d
```

For source installations, install Chromium and set `LABEL_RENDERER=chromium`.
`LABEL_RENDER_STATIC_DIR` can select the built frontend directory, and
`LABEL_RENDER_CHROMIUM_EXECUTABLE` can select the browser executable.

Chromium handles one render at a time across server workers. A busy request
returns `503` with `Retry-After: 1`. A Chromium request where Chromium is not
installed returns `503` without a retry hint.

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

{"id": 42, "spool_id": 123, "preset_id": 7}
```

`preset_id` is optional. When omitted, the user's selected preset is resolved
when the request is queued, with Default as the fallback. Send `preset_id=0` to
request Default explicitly. The request lasts five minutes and appears only in
an open FilaMan tab signed in as the API key's user.
The person can dismiss it or open the label page and choose **Print** or
**Export PDF**. A `201` confirms that the request was queued, not that anything
was physically printed.

These endpoints are used by FilaMan's browser UI; device clients do not need to
call them directly:

```text
GET  /api/v1/labels/print-requests/pending
POST /api/v1/labels/print-requests/{id}/claim
```

## Errors

- `401`: check the API key.
- `403`: check the scope or user-key requirement.
- `404`: refresh the spool or preset.
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
