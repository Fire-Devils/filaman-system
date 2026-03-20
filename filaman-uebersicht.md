# FilaMan – Das Filament-Management-System

## Executive Summary

**FilaMan** ist eine webbasierte Open-Source-Anwendung, die speziell für die zentrale Verwaltung, Organisation und Überwachung von 3D-Drucker-Filamenten entwickelt wurde. Das System richtet sich sowohl an Einzelpersonen als auch an Teams und ermöglicht eine präzise Kontrolle über den gesamten Filamentbestand. Durch die Kombination einer leistungsstarken Backend-Software mit einer optionalen Hardware-Erweiterung (einer smarten ESP32-Waage mit RFID-Integration) bietet FilaMan eine nahtlose Lösung von der Lagerhaltung bis zur automatisierten Verbrauchserfassung direkt am 3D-Drucker.

---

## Kernfunktionen und Analyse der Hauptthemen

Das System basiert auf einer modularen Struktur, die verschiedene Aspekte des 3D-Druck-Workflows abdeckt:

### 1. Umfassende Bestandsverwaltung
*   **Spulen- und Füllstandsüberwachung:** Erfassung jeder Filamentspule mit Daten zu Gewicht, Status und Lagerort. Das System berechnet automatisch den Füllstatus (Full, Normal, Low, Critical, Empty) und gibt Warnungen bei niedrigem Bestand aus.
*   **Strukturierte Stammdaten:** Verwaltung von Herstellern und Filamentprodukten inklusive Materialtyp, Durchmesser und Farben.
*   **Lagerorte:** Definition spezifischer Lagerplätze, die zur schnellen Identifikation mit RFID-Integration verknüpft werden können.

### 2. Konnektivität und Integration
*   **Druckerintegration:** Über Plugins können 3D-Drucker via OctoPrint oder Klipper/Moonraker angebunden werden, um den Filamentverbrauch automatisch zu erfassen.
*   **Home Assistant:** Ein spezielles Add-on ermöglicht die Integration in bestehende Smart-Home-Umgebungen.
*   **API-Unterstützung:** Eine REST-API sowie Geräte-Token erlauben die Anbindung externer Geräte und Automatisierungen.

### 3. Benutzer- und Datenverwaltung
*   **Mehrbenutzersystem:** Rollenbasierte Zugriffskontrolle (Administrator, User, Viewer) mit individuell konfigurierbaren Berechtigungen.
*   **Erweiterbarkeit:** Nutzer können Zusatzfelder für Spulen und Filamente definieren, um das System an spezifische Anforderungen anzupassen.
*   **Mehrsprachigkeit:** Die Benutzeroberfläche unterstützt mehrere Sprachen, darunter Deutsch und Englisch.

---

## Architektur und Technologie

Das FilaMan-System ist in zwei Hauptkomponenten unterteilt: die Software-Zentrale und die Hardware-Erweiterung.

### Software-Architektur (Backend & Frontend)
Das System ist für die Bereitstellung via Docker optimiert, kann aber auch lokal entwickelt werden.

| Komponente | Technologie |
| :--- | :--- |
| **Backend** | Python 3.11+, FastAPI, SQLAlchemy 2.0, Alembic |
| **Frontend** | Astro, Tailwind CSS (Modernes, responsives Design mit Dark-Mode) |
| **Datenbanken** | SQLite (Standard), MySQL, PostgreSQL |
| **Authentifizierung** | OIDC (OAuth2) für Single Sign-On (SSO) |

### Hardware-Architektur (FilaMan ESP32 Scale)
Die Hardware-Erweiterung ermöglicht die physische Interaktion mit den Spulen durch Gewichtsmessung und RFID-Erkennung.

**Benötigte Hardware-Komponenten:**
*   **Mikrocontroller:** ESP32 Development Board.
*   **Gewichtsmessung:** HX711 5kg Lastzellen-Verstärker inklusive Lastzelle.
*   **RFID/NFC-Modul:** PN532 NFC-Modul zur Identifikation von Spulen.
*   **Display:** 0.96 Zoll OLED (SSD1306) zur Anzeige von Gewicht und Verbindungsstatus.
*   **Optional:** TTP223 Touch-Sensor für Tara-Funktionen.

---

## Zielgruppe und Anwendungsszenarien

Das System ist für unterschiedliche Anwendergruppen konzipiert:
1.  **Hobby-Anwender:** Zur Vermeidung von Leerspulen während eines Drucks und zur Organisation kleinerer Bestände.
2.  **Teams & Maker-Spaces:** Durch die Mehrbenutzerfähigkeit und Rollenverwaltung ideal für gemeinschaftlich genutzte Drucker-Infrastrukturen.
3.  **Nachhaltigkeitsbewusste Nutzer:** Durch die Kooperation mit der **Recycling Fabrik** wird die Rückführung von 3D-Druck-Abfällen und Leerspulen in den Kreislauf gefördert.

---

## Wichtige Zitate und Kontext

> *"FilaMan ist eine webbasierte Open-Source-Anwendung zur Verwaltung von 3D-Drucker-Filamenten. Sie ermöglicht es Einzelpersonen und Teams, ihren gesamten Filamentbestand zentral zu erfassen, zu organisieren und zu überwachen."*

Dieses Zitat unterstreicht den zentralen Zweck der Software als Organisationswerkzeug. Ein weiterer wichtiger Entwicklungsschritt wird in der Dokumentation zur Hardware hervorgehoben:

> *"Starting with v3.0.0, this system requires the FilaMan-System backend. Previous direct integrations (Spoolman, MQTT, Bambu Lab) have been moved to the central FilaMan-System."*

Dies verdeutlicht die Konsolidierung des Ökosystems hin zu einer zentral gesteuerten Architektur, bei der die Hardware lediglich als Eingabegerät für das Backend fungiert.

---

## Actionable Insights (Handlungsempfehlungen)

1.  **System-Installation:** Der effizienteste Weg zur Nutzung von FilaMan ist die Bereitstellung via **Docker**. Das Standard-Image ist unter `http://localhost:8083` nach der Installation erreichbar.
2.  **Hardware-Integration:** Um den vollen Funktionsumfang (automatisches Wiegen und Identifizieren) zu nutzen, sollte die **FilaMan-System-ESP32-Waage** gebaut werden. Die automatische Synchronisation erspart die manuelle Dateneingabe nach jedem Wiegevorgang.
3.  **Hersteller-Kooperation nutzen:** Durch die Partnerschaft mit der **Recycling Fabrik** können künftig Spulen mit vorprogrammierten NFC-Tags bezogen werden. Diese ermöglichen eine "Zero Manual Setup"-Erfahrung: Scannen, Wiegen und sofortige Integration in das System ohne manuelle Stammdateneingabe.
4.  **Sicherheit:** Bei der Nutzung von MySQL oder PostgreSQL in einer Produktivumgebung ist darauf zu achten, dass Backups extern verwaltet werden müssen, da die automatische SQLite-Sicherung in diesen Fällen deaktiviert ist.