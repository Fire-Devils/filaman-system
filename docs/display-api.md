# Display API — build your own dashboard or digital swatch board

`GET /api/v1/display` is a read-only feed of every printer FilaMan manages: each
AMS unit, each slot, and the filament in it (colour, material, manufacturer,
remaining amount), plus a small printer/job summary. It exists so you can build
a wall display, an e-paper swatch panel, a tablet kiosk or a Home Assistant card
without knowing anything about FilaMan's internals or the printer driver.

FilaMan ships a reference client at `/display` (a full-screen swatch board that
runs in any browser). Read its source in `frontend/src/pages/display.astro` —
it is ~200 lines and uses nothing but this endpoint.

## Endpoints

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/v1/display` | All active printers |
| `GET` | `/api/v1/display/printers/{id}` | One printer, same envelope |

Query parameters:

- `fields=full` (default) — everything below.
- `fields=slots` — only what a swatch board needs (id/name/state/active + per slot:
  `slot, label, empty, active, color, material, remaining_percent, spool_id`).
  A two-AMS printer is well under 2 KB; fine for a microcontroller.

## Authentication

Any principal holding the `display:read` permission:

- a logged-in browser session (the kiosk page uses this),
- a personal API key,
- **a registered device** — register your panel like a scale (Admin → Devices),
  give it the `display:read` scope, and send `Authorization: Device <token>`.

Users and viewers get `display:read` by default.

## Polling cheaply

The response carries an `ETag`. Send it back as `If-None-Match`; if nothing on
the board changed you get `304 Not Modified` with no body. Poll every 3–10 s.

```
GET /api/v1/display?fields=slots
If-None-Match: W/"9f2c…"
Authorization: Device 12.34.abcdef…
```

## Schema (version 3)

```jsonc
{
  "schema_version": 3,
  "generated_at": "2026-09-04T18:00:00+00:00",
  "printers": [
    {
      "id": 11,
      "name": "P2S",
      "driver": "bambuddy",
      "connected": true,              // null when the driver reports nothing
      "state": "RUNNING",             // driver's state string, "unknown" if none
      "job": {                        // null without live data
        "name": "benchy.3mf",
        "progress": 42,               // 0-100
        "layer": 57, "total_layers": 130,
        "remaining_seconds": 3720
      },
      "temperatures": {               // null without live data; °C integers
        "nozzle": 220, "nozzle_target": 220,
        "bed": 60,  "bed_target": 60,
        "chamber": 31, "chamber_target": null
      },
      "speed_level": 2,               // Bambu 1-4, raw
      "active": { "ams_id": 0, "slot": 1 },   // slot currently feeding, or null
      "alerts": [
        { "id": "print-paused", "severity": "warn", "title": "Print paused",
          "detail": "benchy.3mf", "source": "printer" }
      ],
      "ams": [
        {
          "ams_id": 0,                // as the printer numbers it (AMS-HT start at 128)
          "kind": "ams",              // "ams" | "ams_ht" | "external" (spool holder, id 254/255)
          "label": "AMS A",           // "AMS A".."AMS D", "HT1".. — use it or make your own
          "temperature": 25.4, "humidity": 3,
          "drying": null,             // or { status, target_temp, time }
          "slots": [
            {
              "ams_id": 0, "slot": 0, "label": "A1",
              "empty": false,
              "active": false,
              "color": "#F8A813",     // always #RRGGBB; "#202020" when empty
              "color_name": "Orange",
              "material": "PLA",
              "manufacturer": "SUNLU",
              "filament": "PLA Plus",
              "spool_id": 128,        // FilaMan spool id, null if only the printer sees filament
              "remaining_percent": 51,
              "remaining_grams": 510,
              "remaining_source": "filaman",   // "filaman" | "printer" | null
              "nozzle_min": 190, "nozzle_max": 230,
              "rfid": true,
              "last_used": "2026-09-03T21:10:00+00:00",
              "backup_of": "B2"       // another slot with the same material+colour, or null
            }
          ]
        }
      ]
    }
  ]
}
```

Rules you can rely on:

- Numbers are raw. No pre-formatted strings, no thresholds — decide "low" yourself.
- `color` is always a 7-char `#RRGGBB`. Alpha is stripped.
- A regular AMS always lists slots 0–3, even when empty. An AMS-HT and the external holder list slot 0.
- `spool_id` is set only when FilaMan has a spool assigned to that slot; a slot
  can still be non-empty (the printer sees filament) with `spool_id: null`.
- Adding fields never bumps `schema_version`; changing a field's meaning does.

## What the feed is built from

1. **FilaMan's slot assignments** — which spool is in which slot. This works for
   every printer, with any driver, and yields colour/material/remaining from the
   spool record.
2. **The driver's live state (optional)** — a driver may implement
   `get_display_state()` on its `BaseDriver` subclass to add tray contents as the
   printer sees them, job progress, temperatures and the active slot. The
   Bambuddy driver does. Without it, `connected`, `job` and `temperatures` are
   `null` and the board is still complete.

Driver authors: return either the normalised shape documented in
`app/services/display_service.py::normalize_driver_state`, or a Bambu-style
status dict — both are accepted. Keep it cached; it is called on every poll.
