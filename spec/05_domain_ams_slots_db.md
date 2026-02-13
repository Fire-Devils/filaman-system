# 05 – Domain: AMS/Slots Persistenz (DB Schema)

Status: final  
Version: v1  
Last Updated: 2026-02-13  

---

## 1) Zweck und Scope

Dieses Dokument spezifiziert das Datenbankschema fuer die persistente Abbildung von:
- AMS/MMU Units pro Drucker
- Slots pro Drucker (AMS Slots und Direct Slots)
- Aktuelle Slot-Belegung (Assignments)
- Historie der Slot-Events

Ziel
- Schnelle Queries: "Welche Spulen stecken aktuell im AMS?"
- Verlinkung auf Spulen und damit indirekt Filamente, wenn Identifier gemappt werden koennen

Nicht Teil dieses Dokuments
- Drucker-Stammdaten (siehe 04)
- Spulen/Filamente Tabellen (siehe 01)
- Plugin Interface (siehe 06/07)
- REST API Details (siehe 16)

---

## 2) Abhaengigkeiten

- Depends on:
  - 04_domain_printers_db.md (printers)
  - 01_domain_filaments_db.md (spools, indirect filaments)
- Mapping:
  - spools.rfid_uid und spools.external_id werden fuer Mapping genutzt

---

## 3) Entscheidungen (Decisions)

- Persistenzmodell: P (eigene Tabellen statt nur JSON Eventlog)
- Policy K:
  - Bei spool_removed werden identifiers im aktuellen assignment geloescht (rfid_uid/external_id -> NULL)
- Slot-Belegung:
  - assignment ist 1:1 pro slot (PK slot_id)
- Delete Verhalten:
  - Beim Hard Delete eines Printers sollen AMS/Slot Tabellen per CASCADE mitgeloescht werden
  - filament_printer_profiles blockiert Printer delete (RESTRICT) (Domain 01)

---

## 4) Tabellen

### 4.1 printer_ams_units
Felder
- id (PK)
- printer_id (FK -> printers.id, NOT NULL, ON DELETE CASCADE)
- ams_unit_no (INT, NOT NULL)  (1..n)
- name (TEXT, NULL)
- slots_total (INT, NOT NULL)
- is_active (BOOL, default true)
- custom_fields (JSON, NULL)
- created_at
- updated_at

Constraints/Indizes
- UNIQUE(printer_id, ams_unit_no)
- INDEX(printer_id)

---

### 4.2 printer_slots
Alle Slots eines Druckers, AMS oder Direct.

Felder
- id (PK)
- printer_id (FK -> printers.id, NOT NULL, ON DELETE CASCADE)

- is_ams_slot (BOOL, NOT NULL)
- ams_unit_id (FK -> printer_ams_units.id, NULL, ON DELETE SET NULL)
  - gesetzt wenn is_ams_slot=true
- slot_no (INT, NOT NULL)

- name (TEXT, NULL)
- is_active (BOOL, default true)

- custom_fields (JSON, NULL)
- created_at
- updated_at

Constraints/Indizes
- INDEX(printer_id)
- INDEX(ams_unit_id)
- UNIQUE(printer_id, is_ams_slot, ams_unit_id, slot_no)

Hinweise
- Direct Slots:
  - is_ams_slot=false
  - ams_unit_id=NULL
  - slot_no typischerweise 1..n

---

### 4.3 printer_slot_assignments
Aktueller Zustand pro Slot.

Felder
- slot_id (PK, FK -> printer_slots.id, NOT NULL, ON DELETE CASCADE)

- spool_id (FK -> spools.id, NULL, ON DELETE SET NULL)
  - NULL wenn leer oder unbekannt

- present (BOOL, NOT NULL, default false)

- rfid_uid (TEXT, NULL)
- external_id (TEXT, NULL)
  - speichert Identifiers nur solange present=true
  - bei spool_removed (Policy K) werden diese geloescht

- inserted_at (datetime, NULL)
- updated_at (datetime, NOT NULL)

- meta (JSON, NULL)

Indizes
- INDEX(spool_id)
- INDEX(present)

Verlinkung zu Filament
- Wenn spool_id gesetzt:
  - filament = spools.filament_id

---

### 4.4 printer_slot_events
Historie pro Slot.

Felder
- id (PK)
- printer_id (FK -> printers.id, NOT NULL, ON DELETE CASCADE)
- slot_id (FK -> printer_slots.id, NOT NULL, ON DELETE CASCADE)

- event_type (TEXT, NOT NULL) one of:
  - spool_inserted
  - spool_removed
  - ams_state
  - unknown_spool_detected

- event_at (datetime, NOT NULL)

- spool_id (FK -> spools.id, NULL, ON DELETE SET NULL)
- rfid_uid (TEXT, NULL)
- external_id (TEXT, NULL)

- meta (JSON, NULL)
- created_at

Indizes
- INDEX(printer_id, event_at)
- INDEX(slot_id, event_at)
- INDEX(event_type)
- INDEX(spool_id)

---

## 5) Mapping- und Update-Regeln (Core-Logik Referenz)

### 5.1 Mapping Identifiers -> Spool
- wenn rfid_uid gesetzt:
  - spools.rfid_uid == rfid_uid
- sonst wenn external_id gesetzt:
  - spools.external_id == external_id
- wenn gefunden:
  - spool_id setzen
- sonst:
  - spool_id bleibt NULL

### 5.2 spool_inserted
- slot upsert
- assignment:
  - present=true
  - spool_id ggf. gesetzt
  - rfid_uid/external_id setzen
  - inserted_at=event_at
  - updated_at=event_at
- slot_event insert

### 5.3 spool_removed (Policy K)
- assignment:
  - present=false
  - spool_id=NULL
  - rfid_uid=NULL
  - external_id=NULL
  - inserted_at=NULL
  - updated_at=event_at
- slot_event insert

### 5.4 unknown_spool_detected
- assignment:
  - present=true
  - spool_id=NULL
  - identifiers setzen
  - inserted_at=event_at
  - updated_at=event_at
- slot_event insert

### 5.5 ams_state (Snapshot)
- upsert units/slots
- update assignments gemaess snapshot
- recommended: slot_event nur bei zustandsaenderung (noise reduzieren)

---

## 6) Delete Verhalten (Printers)

Beim DELETE eines Printers:
- CASCADE:
  - printer_ams_units
  - printer_slots
  - printer_slot_assignments (via slot_id cascade)
  - printer_slot_events
- RESTRICT:
  - filament_printer_profiles (blockiert Printer Delete)

---

## 7) Akzeptanzkriterien

- Slots und Assignments koennen upserted werden
- Policy K wird umgesetzt (identifiers cleared on remove)
- Query "current AMS state" ist moeglich via joins:
  - printers -> slots -> assignments -> spools -> filaments
- CASCADE beim Printer delete entfernt alle Slot/AMS Daten

---