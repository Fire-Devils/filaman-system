# Read-only spool metrics

The spool detail page and table use the same read-only effective remaining grams, a percentage pill and estimated
metres remaining. The spool table offers **Remaining %** and **Estimated remaining
length (m)** as optional columns; the default columns are unchanged.

## Native API

Existing `GET /api/v1/spools` and `GET /api/v1/spools/{id}` responses keep their
usual shape. Add `include_metrics=true` to opt into this additional object:

```json
{
  "metrics": {
    "remaining_percent": 50.0,
    "remaining_length_m": 167.6418097083822,
    "effective_remaining_weight_g": 500.0
  }
}
```

The effective weight is the recorded nonnegative finite value, or the linked
filament’s positive nominal net weight when the record is **New** and its recorded
remaining weight is blank. This fallback means a full New spool: its percentage
is 100%, even if legacy gross/tare data differs. Recorded amounts, including zero,
take precedence. Default native API and Spoolman responses keep the original stored
weight; this calculation never rewrites imports.

Each metric can independently be `null` when its inputs are unknown or invalid.
Known zero remaining weight produces zero metrics when the necessary capacity
or material dimensions are known. Metrics are calculated at read time; they are
not stored or writable. POST/PATCH responses do not add the object. There are no
new import fields, migrations or label tokens.

An unknown amount uses a full reel as a visual placeholder, while numeric
readouts remain dashes with no invented percentage or length. Known zero shows
an empty reel and zero readouts. The New Spool form uses the selected filament's
nominal net weight (normally 1,000 g); this known starting amount is not an
unknown-data placeholder.

For the collection endpoint:

| Parameter | Meaning |
| --- | --- |
| `sort_by=effective_remaining_weight_g` | Sort by the displayed weight, including New-spool inference |
| `sort_by=remaining_percent` | Sort by numeric percentage |
| `sort_by=remaining_length_m` | Sort by numeric estimated metres |
| `remaining_percent_min`, `remaining_percent_max` | Inclusive percentage bounds |
| `remaining_length_m_min`, `remaining_length_m_max` | Inclusive metre bounds |
| `sort_order=asc` or `desc` | Existing direction parameter |

Bounds and sorts apply before pagination and to the total count. Unknown metrics
sort last in either direction; equal values use ascending spool ID as a stable
tiebreaker. Bounds exclude unknown values and reject nonfinite query values.
Filtering/sorting by a metric does not require returning the metric object.
With `include_metrics=true`, the existing global `search` also matches the
rounded whole-number metric values; ordinary API searches are unchanged.

## Calculation and units

Stored `remaining_weight_g` is already net filament weight. For inferred New
records the linked filament’s nominal weight supplies the full starting amount.
Other missing recorded weights stay unknown. Tare/core weight is
never subtracted from it again. Capacity is positive gross spool weight minus
nonnegative empty-spool weight, or positive filament nominal net weight when the
former is unavailable/invalid. Percentage is clamped to 0–100.

Estimated metres are `4 × grams / (π × density × diameter²)`, with density in
g/cm³ and diameter in mm. For 500 g, 1.75 mm and 1.24 g/cm³ this is approximately
167.64181 m. Missing, negative or nonfinite inputs are unknown; density/diameter
must be positive. The reel is a schematic using that same percentage, saved
filament colour order/mode and transparency; gradient positions follow the
original strand rather than restarting as the spool is consumed.
Translucent windings use the same neutral checkerboard as color swatches beneath
their saved color. When no valid color is saved, the checkerboard alone keeps
the winding amount visible; a known zero still shows an empty reel.

## Spoolman compatibility

The separate Spoolman adapter is unchanged. Its `remaining_length` and
`used_length` fields remain **millimetres**, including its existing permissive
legacy calculations. They are not aliases for native `remaining_length_m`.
See the [Spoolman API schema](https://donkie.github.io/Spoolman/).

## Database regression checks

The ordinary backend suite exercises SQLite. Set `TEST_POSTGRES_URL` and/or
`TEST_MYSQL_URL` to run the optional PostgreSQL/MySQL projection regression too.
Those tests evaluate literal expressions without creating schemas or changing
rows. They pin the same normal, zero, unknown and extreme-input contracts across
the supported databases; no credentials are embedded in test IDs.
