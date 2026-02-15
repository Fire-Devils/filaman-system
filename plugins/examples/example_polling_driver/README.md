# Example Polling Driver

Beispiel-Plugin fuer FilaMan, das einen einfachen HTTP-Polling-Treiber demonstriert.

## Funktionsweise

Dieses Plugin simuliert einen Drucker-Treiber, der periodisch einen HTTP-Endpoint
abfragt und den AMS-Status als Event emittiert. In einer echten Implementierung
wuerde der HTTP-Client den tatsaechlichen Drucker-API-Endpoint abfragen.

## Konfiguration

| Feld | Typ | Pflicht | Standard | Beschreibung |
|------|-----|---------|----------|-------------|
| `host` | string | Ja | - | Hostname oder IP-Adresse |
| `port` | integer | Nein | 8080 | HTTP-Port |
| `poll_interval_seconds` | integer | Nein | 30 | Abfrageintervall in Sekunden |
| `api_key` | string | Nein | - | Optionaler API-Schluessel |

## Installation

1. Verzeichnis als ZIP verpacken:

```bash
cd plugins/examples/example_polling_driver
zip -r ../../../example_polling_driver.zip .
```

2. Im Admin-Bereich unter **System > Plugins > Plugin installieren** hochladen.

## Verwendung als Vorlage

Dieses Plugin dient als Startpunkt fuer eigene Plugin-Entwicklungen:

1. Verzeichnis kopieren und umbenennen
2. `plugin.json` anpassen (plugin_key, name, etc.)
3. `driver.py` implementieren
4. Testen und als ZIP verpacken
