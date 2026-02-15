# How to Install FilaMan via Docker

This guide explains how to run the FilaMan application using the pre-built and pre-configured Docker image. This is the recommended method for all users.

---

## English

### Prerequisites

- You must have **Docker** installed on your system.

### Installation Steps

This application is designed for easy installation. You only need to run **one command**.

Open a terminal or command prompt and paste the command below. This will create a persistent volume for your data, download the latest FilaMan image, and start it in the background.

**Important:** You must replace `ghcr.io/fire-devils/filaman-system:latest` with the correct image path provided by the project developer.

```bash
docker run -d \
  --name filaman-system-app \
  --restart unless-stopped \
  -p 8000:8000 \
  -v filaman_data:/app/data \
  ghcr.io/fire-devils/filaman-system:latest
```

That's it! The container will now start. Your database and all other application data will be stored in a Docker volume named `filaman_data`.

### Accessing the Application

- **URL:** http://localhost:8000
- **Default Username:** `admin@example.com`
- **Default Password:** `admin123`

It is strongly recommended to change this password after your first login.

### Managing the Container
- **To stop the container:** `docker stop filaman-system-app`
- **To start the container again:** `docker start filaman-system-app`
- **To view logs:** `docker logs -f filaman-system-app`
- **To update the application:** Stop the container (`docker stop ...`), pull the latest image with `docker pull <image_path>`, remove the old container with `docker rm filaman-system-app`, and then run the `docker run` command from above again. Your data will be preserved in the `filaman_data` volume.

---

## Deutsch

### Voraussetzungen

- Sie müssen **Docker** auf Ihrem System installiert haben.

### Installationsschritte

Diese Anwendung ist für eine einfache Installation konzipiert. Sie müssen nur **einen Befehl** ausführen.

Öffnen Sie ein Terminal oder eine Kommandozeile und fügen Sie den folgenden Befehl ein. Dieser Befehl erstellt ein persistentes Volume für Ihre Daten, lädt das neueste FilaMan-Image herunter und startet es im Hintergrund.

**Wichtig:** Sie müssen `ghcr.io/fire-devils/filaman-system:latest` durch den korrekten Image-Pfad ersetzen, den der Projektentwickler bereitstellt.

```bash
docker run -d \
  --name filaman-system-app \
  --restart unless-stopped \
  -p 8000:8000 \
  -v filaman_data:/app/data \
  ghcr.io/fire-devils/filaman-system:latest
```

Das ist alles! Der Container wird nun gestartet. Ihre Datenbank und alle anderen Anwendungsdaten werden in einem Docker-Volume namens `filaman_data` gespeichert.

### Zugriff auf die Anwendung

- **URL:** http://localhost:8000
- **Standard-Benutzername:** `admin@example.com`
- **Standard-Passwort:** `admin123`

Es wird dringend empfohlen, dieses Passwort nach dem ersten Login zu ändern.

### Container verwalten
- **Container stoppen:** `docker stop filaman-system-app`
- **Container wieder starten:** `docker start filaman-system-app`
- **Logs ansehen:** `docker logs -f filaman-system-app`
- **Anwendung aktualisieren:** Stoppen Sie den Container (`docker stop ...`), laden Sie das neueste Image mit `docker pull <image_pfad>`, entfernen Sie den alten Container mit `docker rm filaman-system-app` und führen Sie anschließend den `docker run`-Befehl von oben erneut aus. Ihre Daten bleiben im `filaman_data`-Volume erhalten.
