# 01 – Domain: Filamente und Bestand (DB Schema)

Status: final  
Version: v1  
Last Updated: 2026-02-13  

---

## 1) Zweck und Scope

Dieses Dokument spezifiziert das Datenbankschema fuer den Fachbereich:
- Hersteller
- Filamente (Produktdefinition)
- Farben (Systemfarben) und Filament-Farben Zuordnung
- Lagerorte
- Spulen (physische Bestandsobjekte)
- Spulen-Status (konfigurierbar)
- Spulen-Events (Audit/History, Gewicht, Status, Location, drying etc.)
- Filament-Druckprofile pro Drucker (Relation, Drucker-Tabelle kommt in Domain 04)
- Filament-Bewertungen (Ratings)

Nicht Teil dieses Dokuments
- Users/RBAC Tabellen (siehe 02)
- Devices Tabelle (siehe 03)
- Printers/AMS Slot Tabellen (siehe 04/05)
- REST API Endpoints (siehe API Specs)

---

## 2) Abhaengigkeiten

- Depends on:
  - 02_domain_users_rbac_db.md (users.id FK in spool_events.user_id und filament_ratings.user_id)
  - 03_domain_devices_db.md (devices.id FK in spool_events.device_id)
  - 04_domain_printers_db.md (printers.id FK in filament_printer_profiles.printer_id)

---

## 3) Entscheidungen (Decisions)

- Custom Fields: JSON Feld `custom_fields` pro Entitaet (J)
- Farben: normalisiert ueber `colors` + `filament_colors` (B)
- Farbe: `colors` hat `name` + `hex_code` und ist unique(name, hex_code) (U2)
- Hersteller-Farbname: `filaments.manufacturer_color_name` (pro Filament)
- Durchmesser: `filaments.diameter_mm` ist Pflicht
- Material Subgroup: `filaments.material_subgroup` getrennt von `type`
- Finish: `filaments.finish_type` als enum/string (solid/translucent/neon/glow)
- Spule = ein physisches Objekt (ein Datensatz)
- Spulen-Status: eigene Tabelle `spool_statuses`, global; Status loeschen nur wenn nicht referenziert (RESTRICT)
- Spulen-Loeschen: Soft Delete via `spools.deleted_at`
- Gewicht:
  - `spools.initial_total_weight_g` (Brutto bei Ankunft)
  - `spools.empty_spool_weight_g` (Tara spulenspezifisch)
  - `spools.remaining_weight_g` (Cache)
  - Events in `spool_events` sind Audit/History
- Events:
  - `spool_events.user_id` zusaetzlich (wer hat geaendert)
  - `spool_events.device_id` zusaetzlich (wenn Device gemessen hat)
- "Fast leer": `spools.low_weight_threshold_g` default 100
- Druckparameter sind druckerabhaengig: `filament_printer_profiles` (Option B)
- Filament Bewertung: pro User+Filament eine Bewertung (UNIQUE) mit Sternewert

---

## 4) Tabellen

Hinweis Datentypen
- PK: integer (autoincrement) oder UUID (v1 Empfehlung: integer)
- JSON:
  - SQLite: TEXT (JSON serialisiert)
  - Postgres: JSONB
  - MySQL: JSON
- Preise: DECIMAL empfohlen
- Gewichte: number (float/decimal); v1 kann float nutzen, solange sauber gerundet wird

### 4.1 manufacturers
Felder
- id (PK)
- name (NOT NULL, UNIQUE)
- url (NULL)
- custom_fields (JSON, NULL)
- created_at
- updated_at

Indizes
- UNIQUE(name)

---

### 4.2 filaments
Felder
- id (PK)
- manufacturer_id (FK -> manufacturers.id, NOT NULL)

- designation (NOT NULL)
- type (NOT NULL)  (PLA, PETG, TPU, ...)
- material_subgroup (NULL) (PLA+, Silk, Matte, CF-PETG, ...)
- diameter_mm (NOT NULL) (1.75, 2.85, 3.00)

- manufacturer_color_name (TEXT, NULL)
- finish_type (TEXT, NULL) enum/string:
  - solid
  - translucent
  - neon
  - glow

- raw_material_weight_g (NULL)
- default_spool_weight_g (NULL)
- price (NULL) (DECIMAL empfohlen)
- shop_url (NULL)
- density_g_cm3 (NULL)

- color_mode (NOT NULL) enum/string: single | multi
- multi_color_style (NULL) enum/string: striped | gradient

- custom_fields (JSON, NULL)
- created_at
- updated_at

Indizes
- INDEX(manufacturer_id)
- optional INDEX(type)
- optional INDEX(diameter_mm)

Delete Behavior
- RESTRICT via spools.filament_id (siehe Spools)
- RESTRICT via filament_printer_profiles.filament_id

---

### 4.3 colors
Felder
- id (PK)
- name (NOT NULL)
- hex_code (NOT NULL) (Format: #RRGGBB)
- custom_fields (JSON, NULL)
- created_at
- updated_at

Constraints/Indizes
- UNIQUE(name, hex_code)

Delete Behavior
- RESTRICT wenn referenziert durch filament_colors.color_id

---

### 4.4 filament_colors
Felder
- id (PK)
- filament_id (FK -> filaments.id, NOT NULL, ON DELETE CASCADE)
- color_id (FK -> colors.id, NOT NULL)
- position (INT, NOT NULL, default 1)
- display_name_override (NULL)
- created_at

Constraints/Indizes
- UNIQUE(filament_id, position)
- INDEX(filament_id)
- INDEX(color_id)

---

### 4.5 locations
Felder
- id (PK)
- name (NOT NULL)
- identifier (NULL)
- custom_fields (JSON, NULL)
- created_at
- updated_at

Constraints/Indizes
- optional UNIQUE(name)

Delete Behavior
- RESTRICT wenn referenziert durch spools.location_id oder spool_events.*_location_id oder printers.location_id

---

### 4.6 spool_statuses
Felder
- id (PK)
- key (TEXT, NOT NULL, UNIQUE)
- label (TEXT, NOT NULL)
- description (NULL)
- sort_order (INT, default 0)
- is_system (BOOL, default false)
- created_at
- updated_at

Default Seeds (is_system=true)
- new
- opened
- drying
- active
- empty
- archived

Delete Behavior
- RESTRICT wenn referenziert (spools.status_id, spool_events.from/to_status_id)

---

### 4.7 spools
Felder
- id (PK)
- filament_id (FK -> filaments.id, NOT NULL)
- status_id (FK -> spool_statuses.id, NOT NULL, ON DELETE RESTRICT)

- lot_number (NULL)

- rfid_uid (NULL, UNIQUE)
- external_id (NULL, UNIQUE)

- location_id (FK -> locations.id, NULL)

- purchase_date (date/datetime, NULL)
- expiration_date (date/datetime, NULL)
- purchase_price (DECIMAL, NULL)

- stocked_in_at (datetime, NULL)
- last_used_at (datetime, NULL)

- initial_total_weight_g (NULL)
- empty_spool_weight_g (NULL)
- remaining_weight_g (NULL)

- spool_outer_diameter_mm (NULL)
- spool_width_mm (NULL)

- low_weight_threshold_g (INT, NOT NULL, default 100)

- deleted_at (datetime, NULL)

- custom_fields (JSON, NULL)
- created_at
- updated_at

Indizes
- INDEX(filament_id)
- INDEX(status_id)
- INDEX(location_id)
- INDEX(deleted_at)
- optional INDEX(purchase_date)
- optional INDEX(lot_number)
- UNIQUE(rfid_uid) (NULL erlaubt)
- UNIQUE(external_id) (NULL erlaubt)

Delete Behavior
- Soft delete via deleted_at (API). Historie bleibt in spool_events etc.

---

### 4.8 spool_events
Felder
- id (PK)
- spool_id (FK -> spools.id, NOT NULL, ON DELETE CASCADE)

- event_type (NOT NULL) enum/string:
  - stock_in
  - print_consumption
  - manual_adjust
  - measurement
  - move_location
  - drying
  - opened
  - empty
  - archived

- event_at (datetime, NOT NULL)

- user_id (FK -> users.id, NULL)
- device_id (FK -> devices.id, NULL)

- source (NULL) (ui|api|mqtt|import|system)
- delta_weight_g (NULL)
- measured_weight_g (NULL) (Brutto)
- from_status_id (FK -> spool_statuses.id, NULL)
- to_status_id (FK -> spool_statuses.id, NULL)
- from_location_id (FK -> locations.id, NULL)
- to_location_id (FK -> locations.id, NULL)
- note (TEXT, NULL)
- meta (JSON, NULL)
- created_at

Indizes
- INDEX(spool_id, event_at)
- INDEX(event_type)
- INDEX(user_id)
- INDEX(device_id)
- optional INDEX(spool_id, event_at DESC) (letztes Event)

Meta Konventionen (v1)
- drying:
  - meta.temperature_c (number)
  - meta.duration_h (number)
- manual_adjust:
  - meta.adjustment_type: "relative" | "absolute"
- clamp/auto:
  - meta.clamped_to_zero (bool)
  - meta.auto (bool)
  - meta.trigger_event_id (int)
  - meta.source (string)

Delete Behavior
- Events sind Audit; API sollte Events i.d.R. nicht loeschen (Policy). Wenn doch, nur Admin.

---

### 4.9 filament_printer_profiles
Druckparameter pro Filament und Drucker.

Felder
- id (PK)
- filament_id (FK -> filaments.id, NOT NULL, ON DELETE CASCADE)
- printer_id (FK -> printers.id, NOT NULL, ON DELETE RESTRICT)
- profile_name (TEXT, NOT NULL)

- is_default_for_printer (BOOL, default false)

- nozzle_diameter_mm (NULL)
- extruder_type (NULL)

- nozzle_temp_c (NULL)
- bed_temp_c (NULL)
- chamber_temp_c (NULL)

- print_speed_mm_s (NULL)
- travel_speed_mm_s (NULL)
- first_layer_speed_mm_s (NULL)
- max_volumetric_flow_mm3_s (NULL)

- flowrate_percent (NULL)
- extrusion_multiplier (NULL)
- pressure_advance_k (NULL)
- linear_advance_k (NULL)

- retraction_mm (NULL)
- retraction_speed_mm_s (NULL)
- deretraction_speed_mm_s (NULL)
- retraction_extra_prime_mm3 (NULL)

- fan_percent_min (NULL)
- fan_percent_max (NULL)
- fan_first_layer_percent (NULL)

- z_hop_mm (NULL)
- z_hop_only_when_retracting (NULL)
- bridge_flow_percent (NULL)
- bridge_fan_percent (NULL)

- material_notes (TEXT, NULL)
- custom_fields (JSON, NULL)
- created_at
- updated_at

Indizes
- INDEX(filament_id)
- INDEX(printer_id)

Hinweis
- "Default pro (filament, printer)" wird per App-Logik oder spaeter DB-Constraint sichergestellt.

---

### 4.10 filament_ratings
Bewertung pro User pro Filament (R1).

Felder
- id (PK)
- filament_id (FK -> filaments.id, NOT NULL, ON DELETE CASCADE)
- user_id (FK -> users.id, NOT NULL)
- stars (INT, NOT NULL) (1..5)
- title (NULL)
- comment (TEXT, NULL)
- created_at
- updated_at

Constraints/Indizes
- UNIQUE(filament_id, user_id)
- INDEX(filament_id)
- INDEX(user_id)

---

## 5) Business Rules / Policies (Referenz)

Diese Regeln sind in Service Specs detailliert (09_backend_service_policies.md), hier nur als Verweis:

- Measurement Brutto:
  - measured_weight_g ist Spule+Filament
  - remaining = measured_weight_g - tara (wenn tara vorhanden)
- Tara missing (T2):
  - Event speichern, remaining nicht berechnen
- Relative events ohne anchor (R0):
  - Event speichern, remaining bleibt NULL
- Clamp to zero + Auto empty (D3):
  - remaining < 0 => 0
  - remaining == 0 => status empty + empty event
- Spools soft delete:
  - deleted_at setzen

---

## 6) Security & Compliance Notes

- rfid_uid und external_id sind PII-aehnlich; vorsichtig loggen.
- Tokens/Secrets sind nicht Teil dieser Domain (siehe 02/03).
- spool_events sind Audit: nicht automatisch loeschen.

---

## 7) Akzeptanzkriterien

- Migrationen koennen aus den Tabellen erzeugt und angewandt werden (SQLite)
- UNIQUE constraints fuer rfid_uid/external_id und colors(name,hex_code) greifen
- RESTRICT rules verhindern ungueltige deletes (filaments/colors/locations/spool_statuses)
- spool_events kann sowohl user_id als auch device_id referenzieren
- filament_printer_profiles hat profile_name NOT NULL

---

## 8) Appendix

Hinweis zu Datentypen
- price/purchase_price: DECIMAL empfohlen
- weights: float/decimal; v1 float ok, aber konsistente Rundung definieren
- datetime: ISO-8601 in API, DB speichert in passendem Typ