# Bundled label presets

The freeform label designer ships the same eight **Standard presets** for spools
and filaments. They are versioned in
`frontend/src/lib/freeform-label/standard-presets.ts`, available on fresh installs
and upgrades, and do not depend on account data or a database seed.

| Preset | Width × height |
| --- | --- |
| Classic | 40 × 30 mm |
| Expanded | 50 × 30 mm |
| Compact | 40 × 25 mm |
| Slim | 40 × 12 mm |
| Optimized for slicers | 40 × 30 mm |
| Vertical | 30 × 40 mm |
| Vertical Bold | 30 × 40 mm |
| Vertical Compact | 25 × 40 mm |

Choose a standard in **Label Designer → Saved presets → Standard presets** and
click **Load**. Edit the working copy and use **Save as New** to store an account
preset. Bundled originals cannot be deleted or overwritten. Standards are also
available in the label sheet preset picker. Account presets with an identical
name take precedence in the sheet picker; the designer's Standard presets group
always loads the bundled original.

These are native, editable reconstructions of the swatch layouts shown on
[3D Filament Profiles](https://3dfilamentprofiles.com/my/spools/details/21472),
inspected September 7, 2026. They retain the label sizes, material bands,
information placement, and QR placement, using the existing **Roboto Condensed**
font. Typography and logo fitting follow FilaMan's renderer.

Content comes from the current FilaMan filament: manufacturer logo, material,
subtype, color name, and RGB hex. The slicer layout uses the manufacturer name
instead of its logo. QR codes use the current FilaMan origin and point to
`/spools/<id>` for spool labels or `/filaments/<id>` for filament labels.

Classic, Expanded, and Vertical include the existing `filament.extruder_temp`
and `filament.bed_temp` tokens, plus `extra.filament.flow_ratio` and
`extra.filament.dry_time_hours`. Missing values stay blank. The calibration
tokens can be changed in the designer to match locally configured extra fields;
these defaults do not select a printer or infer per-printer calibration.

No source-site spool values, logos, images, or QR destinations are bundled.
