# FilaMan API — Spool Creation Workflow (LLM Reference)

Self-contained guide for an agent or script that walks through: **select filament → (optional) set slicer profile → create spool → write RFID tag**, plus related calls.

Replace `{BASE}` with your FilaMan origin (e.g. `https://filaman.example.com`). All JSON APIs below are relative to that origin.

---

## Auth (do this first)

Prefer an **API key** for automation (no CSRF). Session login is fine for browsers.

### Option A — API key (recommended for LLMs / scripts)

Create once while logged into the UI or via session:

```http
POST {BASE}/api/v1/me/api-keys
Content-Type: application/json
Cookie: session_id=...; csrf_token=...
X-CSRF-Token: <same as csrf_token cookie>

{"name": "automation"}
```

Response (token shown **once**):

```json
{"id": 1, "name": "automation", "token": "uak.1.<secret>", "created_at": "..."}
```

All subsequent calls:

```http
Authorization: ApiKey uak.1.<secret>
Content-Type: application/json
```

**No CSRF header** when using ApiKey.

### Option B — Session

```http
POST {BASE}/auth/login
Content-Type: application/json

{"email": "user@example.com", "password": "secret"}
```

Sets cookies `session_id` and `csrf_token`. For every `POST|PUT|PATCH|DELETE` under `/api/v1/*` and `/auth/logout`, send:

```http
Cookie: session_id=...; csrf_token=...
X-CSRF-Token: <exact value of csrf_token cookie>
```

Mismatch → `403 {"code":"csrf_failed","message":"CSRF token mismatch"}`.

### Permissions you need

| Step | Typical permission |
|------|--------------------|
| List/get filaments | authenticated (filament read) |
| Set slicer profile | `filaments:update` / `spools:update` or `printers:update` (picker is intentionally loose) |
| Create spool | `spools:create` |
| Write tag | authenticated user (device online) |

---

## Phase overview

```text
1. Find filament_id
2. (Optional) Set Bambuddy slicer profile on filament
3. (Optional) Pick a non-AMS location_id
4. Create spool → spool_id
5. (Optional) Write RFID via online scale/NFC device
6. (Optional later) Scale weigh → Opened + AMS pending assign
```

Phases 5–6 require physical hardware. Phases 1–4 are pure HTTP.

---

## Phase 1 — Select a filament

### List / search

```http
GET {BASE}/api/v1/filaments?page=1&page_size=50&search=PETG&sort_by=designation&sort_order=asc
Authorization: ApiKey uak...
```

Useful query params:

| Param | Meaning |
|-------|---------|
| `search` | ILIKE on designation, material_type, manufacturer color, manufacturer name |
| `type` | Exact `material_type` (e.g. `PETG`) |
| `manufacturer_id` | Filter by manufacturer |
| `page`, `page_size` | Pagination (`page_size` max 200) |

Response envelope:

```json
{
  "items": [
    {
      "id": 42,
      "designation": "PETG Marble",
      "material_type": "PETG",
      "material_subgroup": null,
      "manufacturer_id": 3,
      "manufacturer": {"id": 3, "name": "Tinmorry"},
      "default_spool_weight_g": 250,
      "raw_material_weight_g": 1000,
      "spool_count": 2
    }
  ],
  "page": 1,
  "page_size": 50,
  "total": 12
}
```

**Remember `id` → that is `filament_id`.**

### Detail (optional)

```http
GET {BASE}/api/v1/filaments/{filament_id}
```

Same shape as a list item (plus colors, etc.). Slicer profile state may appear under `custom_fields`:

- `bambu_profile_base_name`
- `bambu_profiles_by_model`

### Material types helper

```http
GET {BASE}/api/v1/filaments/types
→ ["PLA", "PETG", "ASA", ...]
```

---

## Phase 2 — Optional: set slicer profile (Bambuddy)

Requires at least one printer using the **Bambuddy** driver, healthy, and Bambuddy cloud signed in.

**Prefer setting the profile on the filament before creating spools** so new spools inherit it. Spool-level overrides win over filament.

### 2a. Find a Bambuddy printer id

```http
GET {BASE}/api/v1/printers
```

Pick a printer whose driver is Bambuddy / healthy. Use that `printer_id` for cloud-preset and coverage calls.

### 2b. List cloud presets (picker catalog)

```http
GET {BASE}/api/v1/printers/{printer_id}/driver/cloud-presets?group=base&model=P2S&refresh=1
```

| Query | Purpose |
|-------|---------|
| `group=base` | Dedupe to logical **base names** (what you store) |
| `model=P2S` | Filter to that model token |
| `refresh=1` | Force reload from Bambuddy cloud |

Example item:

```json
{
  "code": "PFUScaa4e95f092eef",
  "name": "Tinmorry PETG Marble @Bambu Lab P2S 0.4 nozzle",
  "displayName": "Tinmorry PETG Marble",
  "baseName": "Tinmorry PETG Marble",
  "model": "P2S",
  "isCustom": true
}
```

**Store / send `baseName` (or `displayName` when grouped), not the PFUS code**, when calling the set-profile APIs below.

### 2c. Set default profile on filament

```http
POST {BASE}/api/v1/filaments/{filament_id}/slicer-profile/default
Authorization: ApiKey uak...
Content-Type: application/json

{
  "base_name": "Tinmorry PETG Marble",
  "apply_to_existing": false
}
```

- `apply_to_existing: true` also pushes the linked profile onto non-archived sibling spools.
- `PUT` on the same path is accepted.

### 2d. Optional per-model override

```http
POST {BASE}/api/v1/filaments/{filament_id}/slicer-profile/models/P2S
{"base_name": "Other Profile Name"}
```

Clear override:

```http
POST {BASE}/api/v1/filaments/{filament_id}/slicer-profile/models/P2S
{"clear_override": true}
```

`{model}` is uppercased server-side (`p2s` → `P2S`).

### 2e. Verify coverage

```http
GET {BASE}/api/v1/printers/{printer_id}/driver/profile-coverage?filament_id={filament_id}
```

Look for `coverage.<MODEL>.status` ∈ `ok` | `fallback` | `missing` | `not_set`, and a resolved `code` (PFUS…).

### Equivalent via driver action

Same operations can go through:

```http
POST {BASE}/api/v1/printers/{printer_id}/driver/action
{
  "action": "set_default_filament_profile",
  "params": {
    "filament_id": 42,
    "base_name": "Tinmorry PETG Marble",
    "apply_to_existing": false
  }
}
```

Other useful actions: `list_cloud_presets`, `list_connected_models`, `get_profile_coverage`, `set_filament_profile_for_model`, `set_default_spool_profile`, `set_spool_profile_for_model`.

You can also set profiles **after** create on `/api/v1/spools/{spool_id}/slicer-profile/...` with the same body shapes (spool default has no `apply_to_existing`).

---

## Phase 3 — Optional: locations

```http
GET {BASE}/api/v1/locations?page=1&page_size=50
```

For **create spool**, only use locations that are **not** driver-managed AMS slots.

Skip any location where:

```text
custom_fields.managed_by  is a string ending in  "_plugin"
```

(e.g. `bambuddy_plugin`). The create API will **null out** those `location_id`s even if you send them — AMS locations are only set when Bambuddy assigns after a physical place.

---

## Phase 4 — Create the spool

### Statuses (optional)

```http
GET {BASE}/api/v1/spools/statuses
```

If `status_id` is omitted, server uses status key **`new`**.

### Create one

```http
POST {BASE}/api/v1/spools
Authorization: ApiKey uak...
Content-Type: application/json

{
  "filament_id": 42,
  "initial_total_weight_g": 1250,
  "empty_spool_weight_g": 250,
  "location_id": 5,
  "lot_number": null,
  "rfid_uid": null,
  "low_weight_threshold_g": 100
}
```

**Minimal valid body:**

```json
{"filament_id": 42}
```

### Create many (what the UI uses)

```http
POST {BASE}/api/v1/spools/bulk
{
  "filament_id": 42,
  "quantity": 1,
  "initial_total_weight_g": 1250,
  "empty_spool_weight_g": 250
}
```

`quantity` is 1–100. If `quantity > 1`, `rfid_uid` and `external_id` are forced to `null`.

### Full `SpoolCreate` fields

| Field | Required | Notes |
|-------|----------|--------|
| `filament_id` | **yes** | From Phase 1 |
| `status_id` | no | Default `new` |
| `lot_number` | no | |
| `rfid_uid` | no | Prefer write-tag (Phase 5); uniqueness enforced |
| `external_id` | no | |
| `location_id` | no | Non-plugin locations only |
| `purchase_date` | no | ISO datetime |
| `purchase_price` | no | |
| `stocked_in_at` | no | |
| `initial_total_weight_g` | no | Filament + empty spool typically |
| `empty_spool_weight_g` | no | Else filament `default_spool_weight_g`, else **250** |
| `spool_core_weight_g` | no | |
| `remaining_weight_g` | no | Else `max(initial − empty, 0)` when both known |
| `spool_outer_diameter_mm` | no | Cascades from filament / **200** |
| `spool_width_mm` | no | Cascades from filament / **65** |
| `spool_material` | no | Cascades from filament |
| `low_weight_threshold_g` | no | Default **100** |
| `custom_fields` | no | Object |

Response: `SpoolResponse` (single create) or array (bulk). **Save `id` → `spool_id`.**

---

## Phase 5 — Write RFID tag

Needs an online FilaMan device with NFC (typically the scale). Async: trigger → device writes → device callbacks → you poll.

### 5a. List online devices

```http
GET {BASE}/api/v1/devices/active
```

```json
[{"id": 1, "name": "Scale+RFID", "ip_address": "192.168.1.50"}]
```

Only devices seen within ~3 minutes. If empty, the device is offline — you cannot write from the API.

### 5b. Start write

```http
POST {BASE}/api/v1/devices/{device_id}/write-tag
Authorization: ApiKey uak...
Content-Type: application/json

{"spool_id": 99}
```

(Also supports `{"location_id": 5}` for location tags.)

Immediate response (write is **not** finished yet):

```json
{
  "success": true,
  "message": "Schreibvorgang wurde gestartet. Bitte Tag bereit halten...",
  "tag_uuid": null
}
```

Backend fire-and-forgets to `http://{device.ip}/api/v1/rfid/write`. Hold an NTAG against the reader.

### 5c. Poll until done

```http
GET {BASE}/api/v1/devices/{device_id}/write-status
```

```json
{
  "status": "pending",
  "tag_uuid": null,
  "removed_from": null,
  "error_message": null,
  "timestamp": "2026-08-01T12:00:00+00:00"
}
```

| `status` | Meaning |
|----------|---------|
| `pending` | Wait / keep polling (~2s interval, ~120s timeout in UI) |
| `success` | Tag written; `tag_uuid` is the chip UID now on the spool |
| `error` | See `error_message` |
| `none` | No write in progress / never started |

On success the server has set `spools.rfid_uid = tag_uuid` (and cleared that UID from any other spool/location).

### Manual UID bind (no device)

If you already know the chip UID:

```http
PATCH {BASE}/api/v1/spools/{spool_id}
{"rfid_uid": "04:A1:B2:C3:D4:E5:F6"}
```

Does **not** write NDEF to the physical tag — only the DB binding.

### Device callback (informational — do not call as a user)

The ESP32 reports success with device auth:

```http
POST {BASE}/api/v1/devices/rfid-result
Authorization: Device dev.{id}.{secret}

{
  "success": true,
  "tag_uuid": "04A1B2C3...",
  "spool_id": 99,
  "remaining_weight_g": null
}
```

---

## Phase 6 — Related: weigh / open / AMS pending (after tag exists)

Not part of “create,” but usually next in physical workflow.

```http
POST {BASE}/api/v1/devices/scale/weight
Authorization: Device ...
{"tag_uuid": "...", "measured_weight_g": 1248.0}
```

Called by the scale device (not typically by your agent). Same request:

1. Records a measurement  
2. Auto-transitions `new` → **Opened** (if tara known)  
3. If the device has `auto_assign_enabled`, arms Bambuddy **`assign_pending_spool`** so the next AMS insert matches  

Write-tag alone does **not** arm AMS pending.

---

## End-to-end example (ApiKey)

```bash
BASE=https://filaman.example.com
AUTH="Authorization: ApiKey uak.1.SECRET"

# 1) Find filament
curl -sS -H "$AUTH" "$BASE/api/v1/filaments?search=Tinmorry%20PETG&page_size=20"

# 2) Optional: set profile (need a Bambuddy printer_id)
curl -sS -H "$AUTH" \
  "$BASE/api/v1/printers/11/driver/cloud-presets?group=base&model=P2S"
curl -sS -X POST -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"base_name":"Tinmorry PETG Marble","apply_to_existing":false}' \
  "$BASE/api/v1/filaments/42/slicer-profile/default"

# 3) Create spool
curl -sS -X POST -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"filament_id":42,"quantity":1,"initial_total_weight_g":1250,"empty_spool_weight_g":250}' \
  "$BASE/api/v1/spools/bulk"

# 4) Write tag
curl -sS -H "$AUTH" "$BASE/api/v1/devices/active"
curl -sS -X POST -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"spool_id":99}' \
  "$BASE/api/v1/devices/1/write-tag"
# poll:
curl -sS -H "$AUTH" "$BASE/api/v1/devices/1/write-status"
```

---

## Agent checklist / failure modes

| Symptom | Likely cause |
|---------|----------------|
| `403 csrf_failed` | Session write without matching `X-CSRF-Token`; use ApiKey instead |
| `401` / auth errors | Wrong `Authorization: ApiKey uak...` prefix/spacing |
| Empty cloud presets | No Bambuddy printer, cloud logout, or wrong `printer_id` |
| Profile set but AMS shows Generic/Bambu | Coverage `missing`/`fallback`; create a Studio **Create Filament** preset and use its base name |
| Create ignored AMS `location_id` | Expected — plugin-managed slots cannot be set on create |
| `devices/active` empty | Device offline / not heartbeating |
| Write stays `pending` | Tag not presented, wrong device, or device cannot reach FilaMan for `/rfid-result` |
| Bulk `quantity>1` with `rfid_uid` | UID stripped; write tags one spool at a time |

---

## Related deeper docs in this repo

- [`WRITE-TAG.md`](../WRITE-TAG.md) — RFID write architecture (German/technical)
- [`Auto-Profile-Info.md`](../Auto-Profile-Info.md) — slicer profile concepts and AMS assign behavior
- Bambuddy plugin user guide: `filaman-bambuddy-plugin/docs/slicer-profiles/README.md`

---

## Quick phase → endpoint map

| Phase | Method | Path |
|-------|--------|------|
| Login | POST | `/auth/login` |
| Create API key | POST | `/api/v1/me/api-keys` |
| Search filaments | GET | `/api/v1/filaments` |
| Filament detail | GET | `/api/v1/filaments/{id}` |
| Cloud presets | GET | `/api/v1/printers/{id}/driver/cloud-presets` |
| Set filament profile | POST | `/api/v1/filaments/{id}/slicer-profile/default` |
| Model override | POST | `/api/v1/filaments/{id}/slicer-profile/models/{model}` |
| Coverage | GET | `/api/v1/printers/{id}/driver/profile-coverage` |
| Locations | GET | `/api/v1/locations` |
| Create spool | POST | `/api/v1/spools` or `/api/v1/spools/bulk` |
| Active devices | GET | `/api/v1/devices/active` |
| Start write tag | POST | `/api/v1/devices/{id}/write-tag` |
| Poll write | GET | `/api/v1/devices/{id}/write-status` |
| Manual RFID bind | PATCH | `/api/v1/spools/{id}` |
