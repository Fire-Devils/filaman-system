# Spoolman API compatibility

FilaMan stores promoted filament properties in native fields. The installed
SpoolmanAPI **v1.0.0** plugin still expects the older custom-field storage.
A read-only adapter is applied when that plugin is loaded, including after a
plugin reinstall. Installed plugin files are not modified.

This preserves the shipped plugin's routes and payloads; it does not implement
the entire current [Spoolman API](https://donkie.github.io/Spoolman/). That API
specifies JSON-encoded strings for extras. The plugin also historically returns
decoded custom values; those accepted formats remain supported here.

- Nozzle and bed temperatures retain their existing scalar Celsius fields.
  A range projects its lower available endpoint; the full range remains in
  FilaMan's native API.
- Former extra fields retain their original names and paths, including nested
  `spoolman_extra` values. Migration/import records their representation before
  removing the old values. Native values are the source of truth after edits.
  Unchanged values retain their original spelling and encoding. Edited scalar
  range extras use the lower available endpoint; range arrays and objects keep
  their shape. Only the top-level temperature contract rounds to integer Celsius.
  CSV extras use a JSON array string if an edited item contains a comma, so item
  contents are not lost.
- Native-only records expose supplied properties under supported legacy extra
  names. Existing extras keep priority; the default `discontinued=false` does not
  add an extra to an otherwise empty record. Reintroduced custom values keep
  priority over historical aliases. Deliberately retained temperature extras
  follow native edits only while their captured value and definition still match.
- Catalog updates retain saved label targets and formatting. Downgrade uses the
  same representation rules to restore current legacy values, including integer
  top-level temperatures, while keeping separate full native-range recovery data.
  Original literal keys and field labels/types/options/config are retained; a
  safe fallback definition is used if a projected value no longer fits its type.
- Zero, false, open ranges and clears remain distinct. Unrelated extras are
  preserved. A manufacturer SKU does not replace `article_number` or its filter.
- Spoolman lengths remain **millimetres**. Native spool metrics use **metres**.
  Existing wire types and identity/null contracts are unchanged.
- The supported plugin exposes read-only routes. This adapter does not add
  write routes, new top-level response fields or printer commands.

Only the known v1.0.0 serializer interface is adapted. Other plugin versions
are left unchanged with a warning; their native-field support must be verified
before deployment. Aliases from older preview builds that lack representation
metadata can follow current native values, but discarded original spelling,
CSV spacing or JSON encoding cannot be recovered.

Regression tests cover a separately loaded legacy plugin package, both loading
paths, migration/import through API output, native edits and clears, nested
spool data, and the existing length/weight contract. No live database or
printer is required.

## Import and editing safeguards

Decoded temperature objects and arrays are converted without stringifying them.
Failed conversions retain their source value and eligible typed definition;
definitions with configured defaults stay extra fields until native defaults have
an equivalent representation. Single-choice strings remain one item even when
containing a comma. Zero purchase prices and empty-reel weights remain zero.

Promoted SYSTEM/LOCAL fields retain their old label paths and typed formatting,
without adding duplicate picker entries. Native compatibility lists survive an
unrelated form save, including comma-containing items and empty arrays. Manage
fields merges only the edited values into a fresh record, preserving independent
profile saves. Both page editors fetch the current record before entering Edit
and submit only deliberately changed native values. Untouched text, unknown saved
select options and ordered colors are preserved. Pending Manage reads cannot
replace a dialog draft or interrupt Edit.

Successful native, extra-field and color writes advance their own baselines before
a later printer write can fail. After a partial failure, retries can revert an
accepted value and keep newer drafts typed during the pending request. Spool RFID slots also rebase
on the accepted response, including device-written backfills. Writable native
numeric scalars and measurements reject nonfinite input with HTTP 422 before
changing stored data.

## Native tag resolution

The separate native `POST /api/v1/filaments/resolve-from-tag` endpoint still
accepts updates to just one temperature endpoint. If that update crosses the
saved opposite endpoint, the effective legacy pair is retained in `min_temp` /
`max_temp` extras while the native range stays valid. A later compatible update
moves the pair into native storage. Explicitly reversed pairs supplied together
still return HTTP 400.
