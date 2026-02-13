# 04 – Domain: Printers (DB Schema)

Status: final  
Version: v1  
Last Updated: 2026-02-13  

---

## 1) Zweck und Scope

Dieses Dokument spezifiziert das Datenbankschema fuer:
- Drucker-Stammdaten
- Plugin/Driver Auswahl und Konfiguration pro Drucker
- Soft Delete optional (Schema enthaelt deleted_at, API Delete kann dennoch Hard Delete nutzen)

Nicht Teil dieses Dokuments
- AMS/Slots Tabellen (siehe 05_domain_ams_slots_db.md)
- Plugins Architektur (siehe 06/07)
- REST API Details (siehe 16_api_resources_4_printers_ams.md)

---

## 2) Abhaengigkeiten

- Depends on:
  - 01_domain_filaments_db.md (locations optional)
- Referenziert von:
  - 01_domain_filaments_db.md:
    - filament_printer_profiles.printer_id -> printers.id

---

## 3) Entscheidungen (Decisions)

- Drucker haben:
  - driver_key (Plugin Identifier)
  - driver_config (JSON)
- Driver config Validierung findet im Plugin statt (V1)
- Druckerloeschung (API) ist Hard Delete, aber:
  - CASCADE fuer AMS/Slot Tabellen (Domain 05)
  - RESTRICT fuer filament_printer_profiles (Domain 01)
- deleted_at ist optional im Schema (kann fuer spaeteres Soft Delete genutzt werden)

---

## 4) Tabellen

### 4.1 printers
Felder
- id (PK)
- name (TEXT, NOT NULL)
- manufacturer (TEXT, NULL)
- model (TEXT, NULL)
- serial_number (TEXT, NULL)

- location_id (FK -> locations.id, NULL)  (Domain 01)
- is_active (BOOL, default true)
- deleted_at (datetime, NULL)

Plugin/Driver
- driver_key (TEXT, NOT NULL)
  - entspricht Plugin Ordnername unter plugins/
- driver_config (JSON, NULL)

- custom_fields (JSON, NULL)
- created_at
- updated_at

Indizes/Constraints
- optional UNIQUE(name)
- optional UNIQUE(serial_number)
- INDEX(location_id)
- INDEX(driver_key)
- INDEX(is_active)
- INDEX(deleted_at)

---

## 5) Driver Config Konventionen (Referenz)

- driver_config ist plugin-spezifisch (Host, Broker, Tokens, Topics)
- Beispiele und Registry: siehe 07_plugins_driver_registry.md

---

## 6) Security Notes

- driver_config kann Secrets enthalten (API keys, MQTT passwords)
- v1: Secrets in Klartext in DB akzeptiert
- spaeter: encryption/secret manager moeglich

---

## 7) Akzeptanzkriterien

- Drucker kann angelegt werden mit driver_key + driver_config
- driver_key kann Plugin eindeutig referenzieren
- filament_printer_profiles kann auf printers referenzieren (RESTRICT beim delete)

---