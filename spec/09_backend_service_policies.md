# 09 – Backend Service Policies (v1) – Business Regeln und Edge Cases

Status: final  
Version: v1  
Last Updated: 2026-02-13  

---

## 1) Zweck und Scope

Dieses Dokument spezifiziert die fachlichen Regeln, die in Services umgesetzt werden muessen:
- Spool Events (measurement, adjustment, consumption, status)
- Berechnung von remaining_weight_g (Cache)
- Tara missing Verhalten (D2)
- Relative events ohne Anchor (REL)
- Clamp/Auto-empty (D3)
- Rebuild remaining_weight_g inkl. System-Events (B2.1/B2.2)
- AMS/Slots Apply Regeln (Event processing)

Nicht Teil dieses Dokuments
- REST API Details (siehe 14/16)
- DB Tabellen (siehe 01/05)

---

## 2) Abhaengigkeiten

- 01_domain_filaments_db.md (spools, spool_events, spool_statuses)
- 05_domain_ams_slots_db.md (AMS Tabellen)
- 06_plugins_architecture.md (Event payload)
- 08_backend_auth_full.md (principal user/device)

---

## 3) Entscheidungen (Decisions)

- D2: Tara missing = T2 store-only (event speichern, remaining nicht berechnen)
- REL: Relative events ohne Anchor = R0 store-only
- D3: Negative remaining = clamp to 0 (N2)
- D3: remaining == 0 => auto-empty (E1)
- D3: rebuild bei Ergebnis 0 => set empty + empty-event (R1)
- B2.1/B2.2: rebuild blocked (tara missing) => remaining NULL + System-Event (E1) + last plausible remaining dokumentieren
- Auto-empty Event wird zusaetzlich zum ausloesenden Event geschrieben (meta.auto=true)

---

## 4) Spool Events – Semantik

### 4.1 measurement (Brutto)
Input
- measured_weight_g ist Brutto (Spule + Filament)
Berechnung
- tara = spools.empty_spool_weight_g sonst filaments.default_spool_weight_g
- remaining = measured_weight_g - tara

D2 Tara missing
- wenn tara unbekannt:
  - event speichern
  - spools.remaining_weight_g unveraendert (oder NULL)
  - optional meta.tara_missing=true

Clamp + Auto-empty
- wenn remaining < 0 => remaining = 0 + meta.clamped_to_zero=true
- wenn remaining == 0 => status empty + empty-event (E1)

---

### 4.2 manual_adjust
meta.adjustment_type Pflicht:
- relative: delta_weight_g nutzen
- absolute: measured_weight_g als Brutto nutzen (wie measurement)

REL R0
- wenn remaining NULL und relative:
  - event speichern, remaining bleibt NULL

D2 Tara missing
- wenn absolute und tara fehlt:
  - event speichern, remaining nicht setzen

Clamp + Auto-empty
- wie oben

---

### 4.3 print_consumption
- delta_weight_g muss negativ sein
- remaining += delta_weight_g

REL R0
- wenn remaining NULL:
  - event speichern, remaining bleibt NULL

Clamp + Auto-empty
- clamp <0 auf 0
- remaining == 0 => empty status + event

last_used_at
- bei consumption: spools.last_used_at = event_at

---

### 4.4 status events
Event types:
- opened
- drying (meta: temperature_c, duration_h)
- empty
- archived

Semantik
- spool.status_id wird auf Status mit spool_statuses.key gesetzt
- spool_events.to_status_id wird gesetzt

---

### 4.5 move_location
- spool.location_id setzen
- spool_events.from_location_id / to_location_id setzen

---

## 5) Clamp + Auto-empty (D3)

- remaining niemals negativ speichern
- bei remaining == 0:
  - wenn spool.status != empty:
    - spool.status -> empty
    - schreibe spool_event empty
      - meta.auto=true
      - meta.trigger_event_id=<ausloesendes event>

---

## 6) Rebuild remaining_weight_g

### 6.1 Basis
- spool_events ordered by event_at asc
- Anchor Events:
  - measurement
  - manual_adjust absolute
- Relative Events:
  - consumption
  - manual_adjust relative

### 6.2 REL R0 im rebuild
- relative events vor erstem Anchor werden fuer Berechnung ignoriert

### 6.3 D2 Tara missing im rebuild (B2.1/B2.2 + E1)
Wenn ein Anchor Event auftritt, aber tara fehlt:
- rebuild ist "blocked"
- last_plausible_remaining_g = remaining_current (kann NULL sein)
- setze spools.remaining_weight_g = NULL
- schreibe System-Event (manual_adjust) mit:
  - meta.source="rebuild"
  - meta.warning="tara_missing"
  - meta.last_plausible_remaining_g=<...>
  - meta.affected_event_id=<id des blockierenden events>
  - note: "Rebuild blocked: tara missing, remaining set to NULL"

### 6.4 Clamp + Auto-empty im rebuild (R1)
- wenn Ergebnis remaining < 0 => clamp 0
- wenn Ergebnis remaining == 0 und status != empty:
  - set status empty
  - schreibe empty-event:
    - meta.auto=true
    - meta.source="rebuild"
    - meta.reason="remaining_rebuilt_to_zero"

---

## 7) AMS/Slots Apply (Core)

Event types:
- spool_inserted
- spool_removed (Policy K: identifiers cleared)
- unknown_spool_detected
- ams_state snapshot

Mapping
- identifiers.rfid_uid -> spools.rfid_uid
- identifiers.external_id -> spools.external_id
- spool_id NULL wenn unknown

Persistenz
- upsert printer_ams_units
- upsert printer_slots
- update printer_slot_assignments
- insert printer_slot_events

Policy K: spool_removed
- assignment.present=false
- spool_id NULL
- rfid_uid/external_id NULL
- inserted_at NULL

---

## 8) Akzeptanzkriterien

- Alle spool event endpoints/flows folgen D2, REL, D3 Policies
- Auto-empty wird korrekt getriggert und geloggt
- Rebuild schreibt system event bei tara missing und setzt remaining NULL
- AMS apply erzeugt konsistente assignments + events, Policy K erfuellt

---