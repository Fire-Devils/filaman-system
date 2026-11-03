# Manufacturer catalog sources

Manufacturers use one shared View/Edit dialog on desktop and mobile. Native manufacturer CRUD remains unchanged. The four spool settings are local fallback values, not a catalog manufacturer's universal reel specification.

The existing `custom_fields` JSON stores optional local `manufacturer_profile` (`contact_email`, `description`) and `catalog_sources`, keyed by provider. Each link contains its stable source `id` and the last explicitly accepted normalized `snapshot`. Unknown metadata is preserved. Existing `filamentdb_id` links are recognized and kept in sync when a FilaManDB association changes.

`ManufacturerSource` in `frontend/src/lib/manufacturer-catalog.ts` isolates provider lookup endpoints, record mapping, detail retrieval and optional logo download. Supply additional adapters through `createManufacturerDialog({ sources: [...] })`; omitting FilaManDB from this array replaces the provider without changing the form. Disabled or unknown source links remain stored. New providers should use authenticated server-side proxies with configured upstream hosts, not arbitrary user-provided fetch URLs.

Opening a linked manufacturer reads catalog details without changing local values. Compare values stages only selected nonblank fields and the source link; Save confirms them. Local spool measurements are never derived from a manufacturer catalog record. A saved snapshot remains usable during catalog outages. Logos are previewed through the authenticated proxy and saved locally only after confirmation; existing logos are preserved unless “Use catalog logos” is selected; a logo failure is reported separately from a successful manufacturer save.

Header inventory tiles open manufacturer-filtered filament, active-spool, or archived-spool lists. Purchase totals link to active or all spools. These links clear saved filters and start at page one so the list matches the clicked metric. Catalog refreshes update only the source display; in-progress comparisons and lookup selections remain intact.

Provider summaries may include semantic status badges: FilaManDB catalog activity is green when active and amber when inactive. Verification is the catalog’s read-only `is_verified` status, independent of local links and edits.
