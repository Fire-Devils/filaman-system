# FilaMan Plugin-System

## Uebersicht

FilaMan unterstuetzt Plugins zur Erweiterung der Drucker-Anbindung. Plugins werden als **ZIP-Dateien** ueber den Admin-Bereich (System > Plugins) installiert. Jedes Plugin stellt einen Drucker-Treiber bereit, der Events (z.B. Spulenwechsel) an den Core emittiert.

---

## Plugin-Struktur

Ein Plugin ist ein Verzeichnis mit folgender Mindeststruktur:

```
mein_plugin/
  plugin.json          # Pflicht: Plugin-Manifest
  __init__.py           # Pflicht: Python Package
  driver.py             # Pflicht: Treiber-Klasse
  README.md             # Optional: Dokumentation
  requirements.txt      # Optional: Python-Abhaengigkeiten
```

### plugin.json (Manifest)

Das Manifest beschreibt das Plugin und wird bei der Installation validiert.

```json
{
  "plugin_key": "mein_plugin",
  "name": "Mein Plugin",
  "version": "1.0.0",
  "description": "Beschreibung des Plugins",
  "author": "Autor Name",
  "min_filaman_version": "1.0.0",
  "driver_key": "mein_plugin",
  "config_schema": {
    "host": {
      "type": "string",
      "required": true,
      "description": "Hostname oder IP-Adresse"
    },
    "port": {
      "type": "integer",
      "required": false,
      "default": 1883,
      "description": "Port-Nummer"
    },
    "api_key": {
      "type": "string",
      "required": false,
      "secret": true,
      "description": "API-Schluessel"
    }
  }
}
```

#### Pflichtfelder im Manifest

| Feld | Typ | Beschreibung |
|------|-----|-------------|
| `plugin_key` | string | Eindeutiger Bezeichner (lowercase, underscores, 3-50 Zeichen) |
| `name` | string | Anzeigename des Plugins |
| `version` | string | Semantische Versionsnummer (z.B. `1.0.0`) |
| `description` | string | Kurzbeschreibung |
| `author` | string | Autor oder Organisation |
| `driver_key` | string | Treiber-Schluessel (muss mit `plugin_key` uebereinstimmen) |

#### Optionale Felder

| Feld | Typ | Beschreibung |
|------|-----|-------------|
| `min_filaman_version` | string | Mindestversion von FilaMan |
| `config_schema` | object | Schema fuer die Treiber-Konfiguration |
| `homepage` | string | URL zur Plugin-Homepage |
| `license` | string | Lizenz (z.B. `MIT`) |

---

## Treiber-Klasse (driver.py)

Jedes Plugin muss eine Klasse `Driver` exportieren, die von `BaseDriver` erbt:

```python
import asyncio
from typing import Any, Callable

from app.plugins.base import BaseDriver


class Driver(BaseDriver):
    driver_key = "mein_plugin"

    def __init__(
        self,
        printer_id: int,
        config: dict[str, Any],
        emitter: Callable[[dict[str, Any]], None],
    ):
        super().__init__(printer_id, config, emitter)
        # Eigene Initialisierung hier

    async def start(self) -> None:
        """Treiber starten (Verbindung aufbauen, Polling beginnen, etc.)"""
        self._running = True
        # Implementierung

    async def stop(self) -> None:
        """Treiber stoppen (Verbindung trennen, Aufgaben abbrechen)"""
        self._running = False
        # Implementierung

    def health(self) -> dict[str, Any]:
        """Gesundheitsstatus zurueckgeben"""
        return {
            "driver_key": self.driver_key,
            "printer_id": self.printer_id,
            "running": self._running,
            "status": "ok",
        }

    def validate_config(self) -> None:
        """Konfiguration validieren (wird beim Start aufgerufen)"""
        if "host" not in self.config:
            raise ValueError("Config-Feld 'host' ist erforderlich")
```

### BaseDriver Interface

| Methode | Pflicht | Beschreibung |
|---------|---------|-------------|
| `start()` | Ja | Treiber starten |
| `stop()` | Ja | Treiber stoppen |
| `health()` | Nein | Health-Status (Standard vorhanden) |
| `validate_config()` | Nein | Config validieren (Standard: noop) |

### Attribute

| Attribut | Typ | Beschreibung |
|----------|-----|-------------|
| `driver_key` | str | Eindeutiger Treiber-Schluessel |
| `printer_id` | int | ID des zugewiesenen Druckers |
| `config` | dict | Treiber-Konfiguration |
| `emit` | Callable | Event-Emitter Funktion |
| `_running` | bool | Laufstatus |

---

## Standard-Events

Plugins emittieren Events ueber `self.emit(event_dict)`. Folgende Events sind standardisiert:

### spool_inserted

```python
self.emit({
    "event_type": "spool_inserted",
    "slot": {
        "is_ams_slot": True,
        "ams_unit_no": 1,
        "slot_no": 2,
        "slots_total": 4,
    },
    "identifiers": {
        "rfid_uid": "04A2B3C4D5",
        "external_id": None,
    },
})
```

### spool_removed

```python
self.emit({
    "event_type": "spool_removed",
    "slot": {
        "is_ams_slot": True,
        "ams_unit_no": 1,
        "slot_no": 2,
    },
})
```

### ams_state (Snapshot)

```python
self.emit({
    "event_type": "ams_state",
    "ams_units": [
        {
            "ams_unit_no": 1,
            "slots_total": 4,
            "slots": [
                {"slot_no": 1, "present": True, "identifiers": {"rfid_uid": "..."}},
                {"slot_no": 2, "present": False},
                {"slot_no": 3, "present": True},
                {"slot_no": 4, "present": False},
            ],
        }
    ],
})
```

### unknown_spool_detected

```python
self.emit({
    "event_type": "unknown_spool_detected",
    "slot": {
        "is_ams_slot": True,
        "ams_unit_no": 1,
        "slot_no": 3,
    },
    "identifiers": {
        "rfid_uid": "UNKNOWN_UID",
    },
})
```

---

## Installation via Admin-Bereich

### Voraussetzungen

- Admin-Berechtigung `admin:plugins_manage`
- Plugin als ZIP-Datei (max. 10 MB)

### Installationsschritte

1. Im Admin-Bereich **System** oeffnen
2. Tab **Plugins** waehlen
3. Auf **Plugin installieren** klicken
4. ZIP-Datei auswaehlen und hochladen

### Pruefung bei Installation

Beim Upload wird das Plugin automatisch geprueft:

1. **ZIP-Validierung**: Ist die Datei ein gueltiges ZIP-Archiv?
2. **Struktur-Pruefung**: Enthaelt das ZIP genau ein Verzeichnis mit den Pflichtdateien?
3. **Manifest-Pruefung**: Ist `plugin.json` gueltig und vollstaendig?
4. **Key-Validierung**: Ist `plugin_key` ein gueltiger Bezeichner (lowercase, underscores)?
5. **Versions-Pruefung**: Ist `version` eine gueltige Semver-Nummer?
6. **Konflikt-Pruefung**: Ist ein Plugin mit demselben Key bereits installiert?
7. **Treiber-Pruefung**: Enthaelt `driver.py` eine `Driver`-Klasse, die von `BaseDriver` erbt?
8. **Sicherheits-Pruefung**: Enthaelt das ZIP keine verdaechtigen Dateien (z.B. Path Traversal)?

### Fehlermeldungen

Bei fehlgeschlagener Pruefung wird eine klare Fehlermeldung angezeigt, z.B.:

- `Ungueltige ZIP-Datei`
- `plugin.json fehlt`
- `Pflichtfeld 'plugin_key' fehlt im Manifest`
- `Plugin 'xyz' ist bereits installiert`
- `driver.py enthaelt keine gueltige Driver-Klasse`

---

## Plugin erstellen (ZIP)

### Schritt fuer Schritt

1. Plugin-Verzeichnis erstellen:

```bash
mkdir mein_plugin
```

2. Pflichtdateien anlegen:

```bash
touch mein_plugin/__init__.py
touch mein_plugin/plugin.json
touch mein_plugin/driver.py
```

3. `plugin.json` ausfuellen (siehe oben)

4. `driver.py` implementieren (siehe oben)

5. Als ZIP verpacken:

```bash
cd mein_plugin && zip -r ../mein_plugin.zip . && cd ..
```

Wichtig: Das ZIP muss die Dateien direkt im Root oder in genau einem Unterverzeichnis enthalten.

### Beispiel-Plugin

Im Verzeichnis `plugins/examples/` befindet sich ein vollstaendiges Beispiel-Plugin:

```
plugins/examples/example_polling_driver/
  plugin.json
  __init__.py
  driver.py
  README.md
```

Dieses Plugin demonstriert einen einfachen HTTP-Polling-Treiber.

---

## Deinstallation

1. Im Admin-Bereich **System > Plugins** oeffnen
2. Beim gewuenschten Plugin auf **Deinstallieren** klicken
3. Bestaetigen

Bei der Deinstallation wird:
- Der Treiber gestoppt (falls aktiv)
- Das Plugin-Verzeichnis entfernt
- Der DB-Eintrag geloescht

Hinweis: Drucker, die diesen Treiber verwenden, muessen manuell einem anderen Treiber zugewiesen oder deaktiviert werden.

---

## Fehlerbehandlung

### Retry / Backoff

Plugins sollten bei Verbindungsverlust ein Exponential Backoff implementieren:

```python
async def _reconnect_loop(self):
    delay = 1
    max_delay = 60
    while self._running:
        try:
            await self._connect()
            delay = 1  # Reset bei Erfolg
            break
        except Exception as e:
            logger.warning(f"Reconnect failed: {e}, retry in {delay}s")
            await asyncio.sleep(delay)
            delay = min(delay * 2, max_delay)
```

### Logging

Plugins nutzen das Standard-Python-Logging:

```python
import logging

logger = logging.getLogger(__name__)
logger.info("Plugin gestartet")
logger.error("Verbindungsfehler: ...")
```

---

## Einschraenkungen (v1)

- Plugins laufen im gleichen Backend-Prozess (kein Sandboxing)
- Nur Drucker-Treiber-Plugins (keine UI-Erweiterungen)
- Kein automatisches Dependency-Management (requirements.txt wird angezeigt, nicht installiert)
- Nur Filament/AMS-Events, keine Druckjob-Steuerung
