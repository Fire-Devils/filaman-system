# Spool types and catalog photos

In the filament editor's **Spool** section, **Choose spool type** searches FilaManDB reel profiles with thumbnails. Selecting one fills its empty weight, material, outer diameter and width once, and saves the catalog profile ID and image reference on the filament. Linked physical spools display that filament's packaging photo. A later measured weight edit retains the selected type; **Match entered values** returns to automatic matching using the current measurements, without changing the numeric fields.

When no type is selected, manually entering all four properties automatically selects a unique matching profile. Weight alone, incomplete values and ambiguous matches never choose a photo. Manual matching does not replace any input values. The link is saved with the filament. FilaManDB must be available for searching and matching; an outage does not discard an existing saved link.

Native API create/update accepts optional `filamentdb_spool_profile_id` (positive integer or null), alongside `filamentdb_spool_image_file` (validated catalog filename or null). Unset response metadata is omitted. Existing requests remain valid. These are catalog references, not new label tokens or changes to the Spoolman API.

## Refreshing a test database from an older source

Normal inventory and complete backups retain both link fields. Replacing a test database with an older backup that lacks them needs an explicit merge before restoration:

1. Back up the existing test database and export its inventory as legacy JSON.
2. Export the incoming source inventory as legacy JSON.
3. From `backend/`, prepare a new backup:

   ```sh
   python -m app.services.spool_profile_links previous-test.json incoming-source.json merged-test.json
   ```

4. Restore `merged-test.json` to the test instance using the normal inventory-import flow.

The helper writes a new file and leaves both sources unchanged. It copies only missing spool-profile/image references. It matches unique manufacturer plus stable FilaManDB or Spoolman external identity, or unique manufacturer/product/material/diameter identity when no external identity exists. Numeric database IDs are never identities; ambiguous records are skipped. Incoming explicit links win. Prices, weights, dimensions and physical spool records are unchanged.

Use this merge only when intentionally retaining test-copy catalog annotations. A normal restore remains an exact restore of its backup. Never replace the production source or another test instance as part of this workflow.
