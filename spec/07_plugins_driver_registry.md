# 07 – Drucker Driver Registry (v1) – Plugin Dokumentation und Config Schemas

Status: final  
Version: v1  
Last Updated: 2026-02-13  

---

## 1) Zweck und Scope

Dieses Dokument listet die verfuegbaren Drucker-Driver (Plugins) und deren erwartete
`printers.driver_config` Felder.

Nicht Teil dieses Dokuments
- Plugin Runtime/Interface (siehe 06)
- DB Tabellen (siehe 04/05)
- REST API (siehe 16)

---

## 2) Allgemeine Konventionen

- printers.driver_key verweist auf den Plugin-Ordnernamen unter plugins/
- printers.driver_config ist ein JSON Objekt, driver-spezifisch
- Standard Events (v1):
  - spool_inserted
  - spool_removed
  - ams_state
  - unknown_spool_detected
- Secrets in driver_config:
  - v1: Klartext akzeptiert
  - spaeter: Verschluesselung/Secret Manager moeglich

---

## 3) Registry Template pro Driver

Jeder Driver Abschnitt enthaelt:
- driver_key
- Zweck
- Protokoll
- Erwartete driver_config Felder (Pflicht/Optional)
- Beispiel driver_config
- Typische Events
- Besonderheiten

---

## 4) Driver: bambulab_mqtt

driver_key
- bambulab_mqtt

Zweck
- Empfaengt AMS und Spool Events von BambuLab Druckern ueber MQTT

Protokoll
- MQTT Subscribe

Erwartete driver_config Felder

Pflicht
- broker_host (string)
- broker_port (int)
- printer_sn (string)
- topic_prefix (string)

Optional
- username (string)
- password (string)
- tls_enabled (bool, default false)
- tls_ca_cert_path (string)
- client_id (string)
- qos (int, default 0)
- keepalive_s (int, default 60)

Beispiel driver_config

    {
      "broker_host": "192.168.1.10",
      "broker_port": 1883,
      "username": "bambu",
      "password": "*****",
      "printer_sn": "01S00A123456789",
      "topic_prefix": "device/01S00A123456789",
      "qos": 0,
      "keepalive_s": 60
    }

Typische Events
- ams_state
- spool_inserted
- spool_removed
- unknown_spool_detected

Besonderheiten
- Topics/Payloads sind modellabhaengig, Mapping passiert im Plugin
- Plugin soll slots_total und ams_unit_no aus Payload ableiten

---

## 5) Driver: moonraker_filament

driver_key
- moonraker_filament

Zweck
- Liest Filament und AMS-aehnliche Informationen ueber Moonraker (HTTP und/oder Websocket)
- Abhaengig vom Setup ggf. nur Snapshots oder auch insert/remove

Protokoll
- HTTP Polling und/oder Websocket

Erwartete driver_config Felder

Pflicht
- base_url (string)

Optional
- api_key (string)
- ws_enabled (bool, default true)
- poll_interval_s (int, default 60)
- timeout_s (int, default 5)

Beispiel driver_config

    {
      "base_url": "http://192.168.1.50:7125",
      "api_key": "*****",
      "ws_enabled": true,
      "poll_interval_s": 60,
      "timeout_s": 5
    }

Typische Events
- ams_state
- spool_inserted (falls detektierbar)
- spool_removed (falls detektierbar)
- unknown_spool_detected

Besonderheiten
- Moonraker liefert nicht immer Slot-Infos ohne Erweiterungen
- v1 kann auch nur "Direct Slot" (is_ams_slot=false, slot_no=1) abbilden

---

## 6) Driver: prusa_http

driver_key
- prusa_http

Zweck
- Kommunikation ueber Prusa HTTP/HTTPS APIs (optional Websocket)
- Fokus auf Filament/Feeder Infos, sofern verfuegbar

Protokoll
- HTTP/HTTPS, optional Websocket

Erwartete driver_config Felder

Pflicht
- base_url (string)

Optional
- api_token (string)
- verify_tls (bool, default true)
- poll_interval_s (int, default 60)
- timeout_s (int, default 5)

Beispiel driver_config

    {
      "base_url": "https://192.168.1.60",
      "api_token": "*****",
      "verify_tls": false,
      "poll_interval_s": 60,
      "timeout_s": 5
    }

Typische Events
- ams_state (nur falls Multi-Feeder vorhanden)
- spool_inserted oder spool_removed (falls detektierbar)
- unknown_spool_detected

Besonderheiten
- Prusa Modelle unterscheiden sich stark; Plugin kapselt Unterschiede
- Ohne Slot-Infos: nur Direct Slot Modell

---

## 7) Neue Driver hinzufuegen

Schritte
1. Ordner plugins/<new_driver_key>/ erstellen
2. driver.py implementieren (Klasse Driver)
3. driver_config mit Pydantic validieren
4. Events im Standardformat emittieren
5. Driver in dieser Registry dokumentieren

---

## 8) Akzeptanzkriterien

- Registry beschreibt alle installierten driver_key Werte
- Jede Config ist nachvollziehbar (Pflicht/Optional + Beispiel)
- Plugin kann mit Config validieren und health() liefern

---