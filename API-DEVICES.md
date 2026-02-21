# FilaMan Device API Documentation

Diese Dokumentation beschreibt die API-Schnittstellen für die Kommunikation zwischen physischen Geräten (z.B. RFID-Waagen, Handheld-Scanner) und dem FilaMan-System.

## 1. Authentifizierung

Alle Anfragen eines Geräts an das System (außer der Registrierung) müssen authentifiziert werden.

- **Header:** `Authorization`
- **Format:** `Device <TOKEN>`
- **Beispiel:** `Authorization: Device dev.1.abc123xyz...`

Der Token wird während des Registrierungsprozesses generiert oder kann im Admin-Bereich rotiert werden.

---

## 2. Onboarding (Registrierung)

Wenn ein neues Gerät in Betrieb genommen wird, erhält es vom Administrator einen 6-stelligen **Device Code**. Mit diesem Code kann sich das Gerät einmalig registrieren, um einen dauerhaften API-Token zu erhalten.

### Gerät registrieren
- **Endpunkt:** `POST /api/v1/devices/register`
- **Header:** `X-Device-Code: <6-STELLIGER-CODE>`
- **Response:**
  ```json
  {
    "token": "dev.1.secret_key_here"
  }
  ```
> **Hinweis:** Nach erfolgreicher Registrierung wird der `device_code` ungültig. Das Gerät muss den erhaltenen `token` sicher speichern.

---

## 3. Lifecycle & Status

Geräte sollten regelmäßig einen Heartbeat senden, um ihren Status auf "Online" zu halten und ihre aktuelle IP-Adresse zu melden.

### Heartbeat senden
- **Endpunkt:** `POST /api/v1/devices/heartbeat`
- **Request Body:**
  ```json
  {
    "ip_address": "192.168.1.100"
  }
  ```
- **Response:** `{"status": "ok"}`
- **Frequenz:** Empfohlen alle 60-120 Sekunden. Ein Gerät gilt nach 180 Sekunden Inaktivität als offline.

---

## 4. Kernfunktionen (Devices -> System)

### Gewicht messen (Scale)
Übermittelt das aktuelle Gewicht einer Spule an das System.

- **Endpunkt:** `POST /api/v1/devices/scale/weight`
- **Request Body:**
  ```json
  {
    "tag_uuid": "sf:25:s5:...", // Optional: RFID Tag UID (bevorzugt)
    "spool_id": 123,           // Optional: Interne ID der Spule (Fallback)
    "measured_weight_g": 850.5 // Aktuelles Gesamtgewicht in Gramm
  }
  ```
  *Hinweis: Mindestens `tag_uuid` oder `spool_id` muss angegeben werden. `tag_uuid` hat Vorrang vor `spool_id`.*

- **Response:**
  ```json
  {
    "remaining_weight_g": 750.0,
    "spool_id": 123,
    "filament_name": "PLA White"
  }
  ```

### Spule lokalisieren / Umstellen (Locate)
Verknüpft eine Spule mit einem Lagerort.

- **Endpunkt:** `POST /api/v1/devices/scale/locate`
- **Request Body:**
  ```json
  {
    "spool_tag_uuid": "sf:25:s5:...", // Optional: RFID UID der Spule (bevorzugt)
    "spool_id": 123,             // Optional: ID der Spule (Fallback)
    "location_tag_uuid": "LOC-1" // Optional: RFID UID des Ortes (bevorzugt)
    "location_id": 1             // Optional: ID des Ortes (Fallback)
  }
  ```
  *Hinweis: RFID UUIDs haben Vorrang vor IDs. Mindestens Spule und Standort müssen durch UUID oder ID identifiziert werden.*

- **Response:**
  ```json
  {
    "success": true,
    "spool_id": 123,
    "location_id": 1,
    "location_name": "Regal A"
  }
  ```

---

## 5. Remote-Aktionen (System -> Device)

Wenn ein Gerät eine IP-Adresse im Heartbeat meldet, kann das System Befehle direkt an das Gerät senden (z.B. zum Beschreiben eines RFID-Tags).

### RFID Tag schreiben
Das System sendet eine Anfrage an die IP des Geräts.
- **URL am Gerät:** `http://<DEVICE_IP>/api/v1/rfid/write`
- **Request vom System:**
  ```json
  {
    "spool_id": 123,      // Wenn eine Spule verknüpft werden soll
    "location_id": 45     // ODER wenn ein Ort verknüpft werden soll
  }
  ```
- **Erwartete Response vom Gerät:**
  ```json
  {
    "tag_uuid": "sf:25:s5:..." // Die UID des beschriebenen Tags
  }
  ```

---

## 6. Fehlercodes

Die API verwendet Standard-HTTP-Statuscodes:
- `200/201`: Erfolg
- `401`: Authentifizierung fehlgeschlagen (Token ungültig)
- `404`: Ressource (Spule, Ort, Gerät) nicht gefunden
- `422`: Validierungsfehler (falsches JSON-Format)
- `500`: Interner Serverfehler
