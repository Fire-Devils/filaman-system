# 06 – Plugins Architektur (v1) – Drucker Driver, Events, Runtime

Status: final  
Version: v1  
Last Updated: 2026-02-13  

---

## 1) Zweck und Scope

Dieses Dokument beschreibt:
- Wie Drucker-Anbindungen als Python-Plugins realisiert werden
- Welche Events Plugins standardisiert emittieren
- Wie der Core diese Events verarbeitet und persistiert
- Runtime Regeln: Start/Stop, Retry/Backoff, Config Validierung

Nicht Teil dieses Dokuments
- Konkrete Driver Config Felder je Plugin (siehe 07)
- DB Tabellen (siehe 04/05)
- REST API (siehe 16)

---

## 2) Abhaengigkeiten

- Depends on:
  - 04_domain_printers_db.md (printers.driver_key, driver_config)
  - 05_domain_ams_slots_db.md (Persistenzziel)
  - 11_backend_logging_health.md (health/logging)
- Event Payload nutzt printer_id und slot Struktur (standardisiert)

---

## 3) Entscheidungen (Decisions)

- Plugin Deployment: lokale Python Module unter plugins/ (B)
- Runtime: alle aktiven Drucker beim App-Start starten (A)
- Retry: endlos mit Exponential Backoff (R1)
- Config Validierung: im Plugin (V1, z.B. Pydantic)
- Sync/State: Plugin entscheidet selbst (P1) ob Push (MQTT) oder Polling (HTTP)
- Scope: Nur Filament/AMS Events, keine Druckersteuerung, kein Print Status

Standard Events (v1)
- spool_inserted
- spool_removed
- ams_state (snapshot)
- unknown_spool_detected

---

## 4) Plugin Deployment Struktur

Beispiel

    backend/app/plugins/
      bambulab_mqtt/
        __init__.py
        driver.py
      moonraker_filament/
        __init__.py
        driver.py

Konventionen
- Plugin Ordnername entspricht driver_key in printers.driver_key
- driver.py exportiert Klasse Driver

---

## 5) Standard Event Model (v1)

Alle Events sind dict/JSON kompatibel und enthalten mindestens:
- event_type (string)
- event_at (ISO-8601 datetime in UTC)
- printer_id (int)
- meta (object optional)

Slot Kontext (fuer insert/remove/unknown)
- slot:
  - is_ams_slot (bool)
  - ams_unit_no (int|null)
  - slot_no (int)
  - slots_total (int|null)

Identifiers (optional)
- identifiers:
  - rfid_uid (string|null)
  - external_id (string|null)
  - vendor_tag (string|null)

ams_state Snapshot
- ams_units: array
  - ams_unit_no
  - slots_total
  - slots: array
    - slot_no
    - present (bool)
    - identifiers (optional)

---

## 6) Plugin Interface (Python)

Jedes Plugin stellt eine Klasse Driver bereit.

Pflicht
- driver_key: str
- __init__(printer_id: int, config: dict, emitter, services)
- start() -> None
- stop() -> None
- health() -> dict

Optional
- sync_state() -> None (Plugin kann intern nutzen; Core ruft nicht zentral)

EventEmitter
- emitter.emit(event_dict: dict) -> None

---

## 7) Core Runtime

### 7.1 Plugin Loader
- import path: plugins.<driver_key>.driver
- class: Driver

### 7.2 Plugin Manager
Beim App-Startup:
- Lade alle printers mit is_active=true und deleted_at IS NULL
- Instanziiere Driver
- Start Driver

Beim Shutdown:
- stop() fuer alle Driver

### 7.3 Health
- Manager speichert health() Resultate pro printer_id
- optionaler Admin Health Endpoint kann diese ausgeben

---

## 8) Fehlerbehandlung (R1)

- Plugin implementiert reconnect/retry mit exponential backoff:
  - 1s, 2s, 4s ... max 60s
- Plugin loggt errors, bleibt aber aktiv
- Core faengt Exceptions beim Persistieren ab und loggt sie (Plugin soll weiterlaufen)

---

## 9) Config Validierung (V1)

- Plugin definiert Pydantic Model fuer driver_config
- Bei ValidationError:
  - Driver startet nicht korrekt
  - health() zeigt error details
  - Core loggt klaren Hinweis

---

## 10) Plugin -> Core Persistenz (D1)

- Plugin schreibt nicht direkt DB
- Plugin emittiert Events
- Core Entry Point:
  - handle_printer_event(event_dict)

Core Verhalten
1. Validierung event payload
2. DB transaction
3. Dispatch zu ams_slots service:
   - upsert units/slots
   - update assignments
   - insert slot_events
4. commit

---

## 11) Nicht-Ziele (v1)

- Druckjob Steuerung
- Print Progress / Temperaturen / Telemetrie als Standard
- Externe Plugin Prozesse (alles im gleichen Backend Prozess)

---

## 12) Akzeptanzkriterien

- Plugins koennen lokal geladen werden ueber driver_key
- Standard Events koennen emittiert und persistiert werden
- Retry/Backoff bei Verbindungsverlust
- health() liefert verwertbaren Zustand

---