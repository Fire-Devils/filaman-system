# Bambu Slicer Profiles — How FilaMan Handles Them

This document describes how FilaMan assigns Bambu cloud slicer profiles to filament
and spools, resolves them per printer model, and pushes the correct settings to AMS
slots when you assign a spool.

Requires the **Bambuddy driver plugin** installed and connected. The profile picker
appears on **Filament** and **Spool** detail pages when at least one Bambuddy
printer driver is healthy.

---

## Quick summary

1. Pick a **default profile** (logical name, e.g. `SUNLU PLA HS PLUS GEN2`) on the
   filament or spool page.
2. FilaMan resolves the correct **cloud variant** (PFUS code) for each connected
   printer **model** (P2S, H2C, …) and **nozzle size** automatically.
3. When you assign the spool to an AMS slot, the driver sends **color**, **temps**,
   **material code**, and **slicer preset** to the printer.
4. If no variant exists for a model, behavior depends on **Admin → App Settings →
   Slicer Profile Fallback** (Generic vs Bambu system profile).

---

## Concepts

| Term | Meaning |
|------|---------|
| **Base name** | Human-readable profile name without model/nozzle suffix, e.g. `SUNLU PLA HS PLUS GEN2`. This is what you pick in the UI. |
| **PFUS / `setting_id`** | Full Bambu cloud preset ID (e.g. `PFUScaa4e95f092eef`). Model- and nozzle-specific. Sent to the printer as `setting_id`. |
| **Material code / `tray_info_idx`** | AMS filament index (e.g. `SUN20009`, `GFL99`, `GFA00`). Identifies the material family on the slot. |
| **Model** | Printer family token from Bambuddy (e.g. `P2S`, `H2C`). Variants are resolved per model, not per individual printer. |
| **Coverage** | Whether a cloud variant exists for each connected model for the chosen base name. |

Cloud presets in Bambu Studio often look like:

`SUNLU PLA HS PLUS GEN2 @BBL P2S 0.4 nozzle`

FilaMan stores the **base name** and resolves the `@BBL <model> <nozzle>` variant at
runtime.

---

## Where profiles are stored

### Filament level
- **Default base name** in `custom_fields.bambu_profile_base_name`
- Optional **per-model map** in `custom_fields.bambu_profiles_by_model`
- Per-printer params: `bambu_slicer_setting_id`, `bambu_idx`, etc.

New spools **inherit** the filament default unless the spool overrides it.

### Spool level
Same fields as filament. Spool values **override** filament for that spool.

### Per-model map shape
```json
{
  "P2S": { "base_name": "SUNLU PLA HS PLUS GEN2", "source": "linked" },
  "H2C": { "base_name": "OTHER PROFILE", "source": "override" }
}
```

**Source values:**
| Source | Meaning |
|--------|---------|
| `linked` | Uses the default base name; variant resolved from cloud. |
| `override` / `manual` | User picked a different profile for this model only. Never auto-deleted. |
| `reflect` | Learned from Bambuddy inventory sync (last-writer-wins with local edits). |
| `auto` | Resolved automatically during mirroring. |

---

## The profile picker (Filament / Spool pages)

### Default profile
- Searchable dropdown of cloud presets available on **at least one** of your
  connected models.
- Pick **one name**; FilaMan fans out variants to every connected model.
- **Variants strip** shows ✓ or ✕ per model (e.g. `H2C ✕  P2S ✓`).

### Per-model overrides (optional)
- Expand a model card to override only that model when it needs a different profile
  than the default.
- Nozzle badges (0.2, 0.4, 0.6, 0.8) show which sizes exist in the cloud; the
  highlighted badge is the nozzle used for resolution.

### Coverage states
| Badge / status | Meaning |
|----------------|---------|
| **Linked profile** (green) | Cloud variant found; exact or closest nozzle match. |
| **Partial coverage** (yellow) | Default is set but one or more models have no cloud variant. |
| **No cloud preset** (red) | No variant for this model — create in Bambu Studio or override. |
| **Fallback nozzle** | Requested nozzle not in cloud; nearest available size used. |

### Refresh cloud presets
- Picker options are cached **~10 minutes** on the driver (shared across requests).
- The picker also caches per model **for the current page session**.
- Click **Refresh cloud presets** after creating new variants in Bambu Studio to
  reload immediately.

---

## Variant resolution (model + nozzle)

For each assign or save, FilaMan:

1. Determines the printer **model** and **nozzle** (live from Bambuddy, or
   `bambu_default_nozzle_mm` on the spool/filament printer params if unknown).
2. Looks up the **base name** for that model (per-model row → default base name).
3. Queries the cloud variant index for `(base_name, model, nozzle)`.
4. Uses **closest nozzle** in cloud if exact size is missing (shown as fallback).

**New printer model connected:** If you already have a default base name but no
per-model row yet, the driver resolves from the default on **first assign** and may
lazily persist the PFUS for that printer — no manual re-save required.

---

## What happens when you assign a spool to an AMS slot

The Bambuddy driver calls the slot `configure` endpoint with:

| Field | Source |
|-------|--------|
| `tray_color` | Spool / filament color |
| `tray_type` | Material type (PLA, PETG, …) |
| `tray_sub_brands` | Filament name / subgroup |
| `nozzle_temp_min` / `max` | Printer params or filament defaults |
| `setting_id` | Resolved PFUS for this model + nozzle |
| `tray_info_idx` | AMS material code (see below) |

### Resolution order for `setting_id`
1. Per-printer `bambu_slicer_setting_id` (if already mirrored).
2. Per-model profile + cloud variant lookup.
3. Default base name + cloud variant lookup (including new-model fallback).
4. Empty if no variant exists.

### Resolution order for `tray_info_idx` (material code)
1. Learned `bambu_idx` on spool/filament printer params.
2. Resolved from `bambu_slicer_setting_id` / PFUS via cloud map.
3. Bambuddy inventory spool preset (if synced).
4. **If `setting_id` is still empty** → **Slicer Profile Fallback** (admin setting).

### Assign-time warning
If coverage for the target printer's model is `missing` or `not_set`, the spool page
asks for confirmation before assigning. You can still proceed; the driver applies the
configured fallback (see below).

---

## Slicer Profile Fallback (Admin → App Settings)

When **no model-specific slicer preset** resolves (`setting_id` empty), FilaMan pins
the AMS material code to a **built-in system profile** so Bambu Studio does not show
a blank/unrecognized profile (which would skip proper flow, cooling, and volumetric
settings).

| Setting | Material code sent | Studio shows |
|---------|-------------------|--------------|
| **Generic profile** (default) | `GFL99`, `GFG99`, … | Generic PLA, Generic PETG, … |
| **Bambu profile** | `GFA00`, `GFG00`, … | Bambu PLA Basic, Bambu PETG Basic, … |

Materials without a Bambu-brand basic (e.g. PA/NYLON, HIPS, PP) fall back to Generic
even when **Bambu profile** is selected.

**Important:**
- Color and nozzle temps are **always** sent regardless of fallback.
- The fallback is **not persisted** — it is applied only for that configure call.
- When a real cloud variant is added later (picker save or new Studio preset +
  refresh), the next assign uses the **real profile** automatically.

---

## Example: one profile on P2S, missing on H2C

**Setup:** Default `SUNLU PLA HS PLUS GEN2`. P2S has a cloud variant; H2C does not.

**Picker shows:** Partial coverage — `P2S ✓`, `H2C ✕`.

**Assign to P2S:** Full SUNLU PFUS + SUNLU material code.

**Assign to H2C (fallback = Bambu):**
- `setting_id` = empty (no H2C variant)
- `tray_info_idx` = `GFA00` (Bambu PLA Basic) — overrides any learned SUNLU code
- Color and temps still from the spool
- Slot uses a valid named profile instead of a blank Studio entry

**After creating** `SUNLU PLA HS PLUS GEN2 @BBL H2C 0.4 nozzle` in Studio and
clicking **Refresh cloud presets**, the picker shows `H2C ✓` and assigns use the
real SUNLU variant on the next load/assign.

---

## Sync with Bambuddy

When inventory sync is enabled, spool profiles can be **reflected** from Bambuddy
(`source: reflect`). Local picker changes are debounced so a reflect sync does not
immediately overwrite a profile you just saved.

Profiles set in FilaMan are mirrored to Bambuddy inventory (`slicer_filament`) across
the fleet when sync runs.

---

## Plugin configuration

On each Bambuddy printer driver:

| Setting | Effect |
|---------|--------|
| **Per-Model Slicer Profiles** (`enabled`, default) | Full behavior described here. |
| **Per-Model Slicer Profiles** (`disabled`) | Legacy single-profile mode; no per-model resolution or fallback logic. |

---

## Troubleshooting

| Symptom | What to check |
|---------|----------------|
| Picker empty or stale | Driver health; click **Refresh cloud presets**. |
| Model shows ✕ | Create `\<base name\> @BBL \<model\> \<nozzle\> nozzle` in Bambu Studio, sync cloud, refresh. |
| Wrong nozzle variant | Nozzle reported by Bambuddy; or set **Default Nozzle Diameter** on spool/filament printer params. |
| Assign uses Generic/Bambu instead of brand profile | No variant for that model — expected until cloud preset exists or you override. |
| Override disappeared | Should not happen for `override`/`manual` sources; report if it does. |

---

## Related files (developers)

| Area | Location |
|------|----------|
| Profile picker UI | `frontend/src/lib/cloud-profile-picker.ts` |
| Spool / filament pages | `frontend/src/pages/spools/[id]/index.astro`, `filaments/[id]/index.astro` |
| API routes | `backend/app/api/v1/printers.py`, `spools.py`, `filaments.py` |
| Fallback setting | `backend/app/models/app_settings.py`, `admin/app-settings.astro` |
| Driver logic | `filaman-bambuddy-plugin/bambuddy/driver.py`, `profile_variants.py` |
