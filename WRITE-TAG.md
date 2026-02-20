# Dokumentation: RFID/NFC Schreibvorgang (Technischer Guide für KI)

Diese Dokumentation beschreibt den Prozess des Schreibens von RFID/NFC-Tags im FilaMan-System. Sie dient als Referenz für KI-Systeme, um zu verstehen, wie Befehle delegiert, verarbeitet und zurückgemeldet werden.

## 1. Architektur-Übersicht (Asynchrones Modell)

Der Schreibvorgang folgt einem **asynchronen Modell**, um robuster für IoT-Geräte mit unzuverlässigen Netzwerkverbindungen zu sein.

```
┌─────────┐    1. Trigger    ┌─────────┐    2. Fire&Forget  ┌─────────┐
│ Frontend│ ────────────────→│ Backend │ ─────────────────→ │ Device  │
└─────────┘                   └─────────┘                    └─────────┘
       ↑                           │                           │
       │    5. Polling             │                           │
       │    /write-status          │ 4. DB-Update              │
       └───────────────────────────┤                           │
                                   │         3. Result-Request │
                                   └───────────────────────────┘
```

### Beteiligte Komponenten:
*   **Frontend:** Initiiert Schreibvorgang und pollt einen Status-Endpunkt am Backend.
*   **Backend:** Delegiert Befehl an Device, bereinigt Dubletten in der DB und stellt den Status bereit.
*   **Device:** Führt physischen Schreibvorgang aus und sendet eigenständig Ergebnis zurück.

---

## 2. Der Ablauf (Step-by-Step)

### Schritt 1: Initiierung (Frontend → Backend)
Das Frontend prüft, ob das Objekt bereits einen Tag hat (Warnung anzeigen) und sendet die Anfrage.
- **Endpunkt:** `POST /api/v1/devices/{device_id}/write-tag`

### Schritt 2: Fire & Forget (Backend → Device)
Das Backend initialisiert den Status des Geräts auf `pending` und sendet einen Trigger an das Device.
- **Endpunkt am Gerät:** `POST http://<DEVICE_IP>/api/v1/rfid/write`
- **Response an Frontend:** Das Backend antwortet sofort (Erfolg der Triggerung).

### Schritt 3: Physische Verarbeitung & Result (Device → Backend)
Das Device führt den Schreibvorgang aus und sendet das Ergebnis an:
- **Endpunkt:** `POST /api/v1/devices/rfid-result`
- **Authentifizierung:** `Authorization: Device <TOKEN>`

### Schritt 4: Datenbank-Update & Dublettenprüfung (Backend)
Das Backend verarbeitet das Ergebnis:
1. **Suche nach Dubletten:** Wenn die neue `tag_uuid` bereits bei einer anderen Spule oder einem anderen Standort hinterlegt ist, wird sie dort **entfernt**.
2. **Update Ziel:** Die `tag_uuid` wird beim Ziel-Objekt gespeichert.
3. **Status speichern:** Das Ergebnis (Erfolg, ggf. Info über entfernte Dublette) wird im Device-Modell (`custom_fields`) gespeichert.

### Schritt 5: Frontend-Polling (Frontend → Backend)
Das Frontend pollt den Status-Endpunkt:
- **Endpunkt:** `GET /api/v1/devices/{device_id}/write-status`
- Sobald der Status `success` ist, wird der Erfolg angezeigt. Falls Dubletten entfernt wurden, wird dies dem Benutzer mitgeteilt (z.B. "Tag von Spule #123 entfernt").

---

## 3. API-Referenz

### 3.1 Trigger Endpoint
**`POST /api/v1/devices/{device_id}/write-tag`** (Antwortet sofort)

### 3.2 Status Endpoint
**`GET /api/v1/devices/{device_id}/write-status`**

Gibt den Status des letzten Schreibvorgangs zurück.

**Response:**
```json
{
  "status": "success",
  "tag_uuid": "E280...",
  "removed_from": "Spule #123",  // Optional: Wenn Dublette bereinigt wurde
  "error_message": null,
  "timestamp": "2024-05-20T..."
}
```

### 3.3 Result Endpoint (Device → Backend)
**`POST /api/v1/devices/rfid-result`** (Vom Device aufzurufen)

---

## 4. Anforderungen an das Device
(Siehe vorherige Version - unverändert: `/api/v1/rfid/write` implementieren und Result an Backend pushen.)

---

## 5. Zusammenfassung der Dubletten-Logik
Das System stellt sicher, dass eine physische Tag-UID **global eindeutig** im System ist. Das Schreiben eines Tags auf ein neues Objekt "stiehlt" diesen Tag automatisch von jedem anderen Objekt, dem er zuvor zugewiesen war.
