# Slicer-Link

## Deutsch

Der Slicer-Link ist ein kleines Python-Skript (nur Standardbibliothek, Python 3.8+). Es läuft nach dem Slicen, liest Filamentverbrauch und Druckzeit aus dem G-Code und meldet sie an FilaMan. Dort entsteht ein offener Druckjob (`source = slicer_link`), den du beim Druckende auf der Seite „Druckjobs“ bestätigst. Erst dann wird der Verbrauch von den Spulen abgebucht.

### Einrichtung

1. Einstellungen, Slicer-Link: Skript herunterladen und an einem festen Ort ablegen.
2. Einstellungen, API-Keys: eigenen Key anlegen. Der Key braucht die Berechtigung `print_jobs:create`.
3. Auf der Slicer-Link-Seite den Drucker wählen und die fertige Befehlszeile kopieren. `PYTHON_PATH` und `SCRIPT_PATH` durch deine Pfade ersetzen.
4. Testen: dieselbe Zeile mit `--test` im Terminal ausführen. Der Drucker steht danach als „verbunden“ auf der Seite.

```
python filaman_slicer_link.py --url https://filaman.local --key <API-KEY> --printer <ID> [--map 0=1,1=2] [--test] <gcode-pfad>
```

Der Key geht auch über die Umgebungsvariable `FILAMAN_API_KEY`. Das Skript beendet sich immer mit Exit-Code 0 und bricht das Slicen nie ab. Fehler stehen in `~/.filaman_slicer_link.log`.

### Je Slicer

- **PrusaSlicer / SuperSlicer:** Druckeinstellungen, Ausgabeoptionen, Nachbearbeitungsskripte: Befehlszeile eintragen.
- **OrcaSlicer / BambuStudio:** Prozess, Sonstiges, Nachbearbeitungsskripte: Befehlszeile eintragen.
- **Cura:** noch kein automatischer Aufruf. Nach dem Export den Befehl von Hand im Terminal ausführen und den G-Code-Pfad anhängen. Cura liefert nur Meter, FilaMan rechnet über Dichte und Durchmesser der Spule in Gramm um (Fallback 1,24 g/cm³ und 1,75 mm).

Der Slicer hängt den G-Code-Pfad selbst als letztes Argument an. Der Jobname kommt aus `SLIC3R_PP_OUTPUT_NAME` oder dem Dateinamen.

### Slot-Zuordnung

Standard: Werkzeug/Filament-Index `i` (T0, T1, …, ab 0) geht an den `i`-ten aktiven Slot des Druckers, sortiert nach `slot_no`. Bei Bambu-Druckern sind das erst die AMS-Slots (AMS 1 Slot 1 bis 4 sind `slot_no` 0 bis 3, AMS 2 folgt mit 4 bis 7), danach der externe Halter. Explizit überschreibst du das mit `--map 0=1,1=2` (Index=`slot_no`, nur die genannten Indizes). Die Slicer-Link-Seite zeigt die Standardzuordnung je Drucker.

Je Index meldet FilaMan zurück, welche Spule gefunden wurde, oder `null` mit Grund `no_slot` (kein Slot) bzw. `slot_empty` (Slot leer). Einträge mit 0 g werden ausgelassen.

### API

Alle Pfade unter `/api/v1/slicer-link`. Auth per Session oder API-Key (`Authorization: ApiKey uak.<id>.<secret>`).

- `POST /jobs` (`print_jobs:create`): `{printer_id, job_name, slicer, slicer_version?, print_time_s?, filaments:[{index, weight_g?, length_mm?, material?, color_hex?}], script_version, slot_map?}`. Antwort: `{job_id, mapping, latest_script_version, update_available}`.
- `POST /ping` (`print_jobs:create`): legt keinen Job an, merkt sich den Kontakt.
- `GET /status`: Kontakt je Drucker, Standardzuordnung, letzte Jobs, neueste Skriptversion.
- `GET /script`: Skript als Download.

Der letzte Kontakt liegt in `slicer_link_contacts.json` im Datenverzeichnis (keine Datenbankmigration).

## English

Slicer-Link is a small Python script (standard library only, Python 3.8+). It runs after slicing, reads filament usage and print time from the G-code and reports them to FilaMan. FilaMan creates an open print job (`source = slicer_link`), which you confirm on the Print Jobs page when the print is done. Only then is the consumption booked on the spools.

### Setup

1. Settings, Slicer-Link: download the script and keep it in a permanent place.
2. Settings, API Keys: create a key of its own. It needs the `print_jobs:create` permission.
3. On the Slicer-Link page pick the printer and copy the finished command line. Replace `PYTHON_PATH` and `SCRIPT_PATH` with your paths.
4. Test: run the same line with `--test` in a terminal. The printer then shows as connected on the page.

```
python filaman_slicer_link.py --url https://filaman.local --key <API-KEY> --printer <ID> [--map 0=1,1=2] [--test] <gcode-path>
```

The key can also come from the `FILAMAN_API_KEY` environment variable. The script always exits with code 0 and never aborts slicing. Errors go to `~/.filaman_slicer_link.log`.

### Per slicer

- **PrusaSlicer / SuperSlicer:** Print Settings, Output options, Post-processing scripts: enter the command line.
- **OrcaSlicer / BambuStudio:** Process, Others, Post-processing scripts: enter the command line.
- **Cura:** no automatic hook yet. After exporting, run the command by hand in a terminal and append the G-code path. Cura only reports metres, so FilaMan converts to grams with the spool's density and diameter (fallback 1.24 g/cm³ and 1.75 mm).

The slicer appends the G-code path as the last argument itself. The job name comes from `SLIC3R_PP_OUTPUT_NAME` or the file name.

### Slot mapping

Default: tool/filament index `i` (T0, T1, … from 0) goes to the `i`-th active slot of the printer, ordered by `slot_no`. On Bambu printers that is the AMS slots first (AMS 1 slots 1 to 4 are `slot_no` 0 to 3, AMS 2 continues with 4 to 7), then the external holder. Override explicitly with `--map 0=1,1=2` (index=`slot_no`, only the listed indexes). The Slicer-Link page shows the default mapping per printer.

For each index FilaMan reports which spool was found, or `null` with reason `no_slot` or `slot_empty`. Entries with 0 g are left out.

### API

All paths under `/api/v1/slicer-link`. Auth by session or API key (`Authorization: ApiKey uak.<id>.<secret>`).

- `POST /jobs` (`print_jobs:create`): `{printer_id, job_name, slicer, slicer_version?, print_time_s?, filaments:[{index, weight_g?, length_mm?, material?, color_hex?}], script_version, slot_map?}`. Response: `{job_id, mapping, latest_script_version, update_available}`.
- `POST /ping` (`print_jobs:create`): creates no job, remembers the contact.
- `GET /status`: contact per printer, default mapping, recent jobs, latest script version.
- `GET /script`: the script as a download.

The last contact is kept in `slicer_link_contacts.json` in the data directory (no database migration).
