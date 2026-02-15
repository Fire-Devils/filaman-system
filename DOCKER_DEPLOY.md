# How to Install FilaMan via Docker Command

This guide explains how to run the FilaMan application using a single Docker command. This is the recommended method for simple deployments.

---

## English

### Prerequisites

- You must have **Docker** installed on your system.

### Installation Steps

**Step 1: Create a Configuration File (`.env`)**  
First, you need to create a configuration file that stores all your settings.

1.  Create a new, empty folder on your computer where you want to store the application data (e.g., `C:\FilaMan` or `/home/user/filaman`).
2.  Inside this new folder, create a file named `.env`.
3.  Paste the following content into this file:

```env
# It is strongly recommended to change these for security
SECRET_KEY=change-me-in-production-with-a-long-random-string
CSRF_SECRET_KEY=change-me-in-production-with-a-long-random-string

# Default Admin User (created on first start)
ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD=admin123
ADMIN_DISPLAY_NAME=Admin
ADMIN_LANGUAGE=en
ADMIN_SUPERADMIN=true

# Production Settings
DEBUG=false
CORS_ORIGINS=*
DATABASE_URL=sqlite+aiosqlite:////app/filaman.db
```
**Important:** For security, you should replace the default values for `SECRET_KEY` and `CSRF_SECRET_KEY` with long, random strings.

**Step 2: Start the Application with Docker**  
Now, open a terminal or command prompt, navigate into the folder you just created, and run the command below.

**Important:** You must replace `ghcr.io/your-username/filaman-system:latest` with the correct image path provided by the project developer.

```bash
docker run -d \
  --name filaman-system-app \
  --restart unless-stopped \
  -p 8000:8000 \
  -v "$(pwd)/filaman.db":/app/filaman.db \
  --env-file .env \
  ghcr.io/your-username/filaman-system:latest
```

Docker will now download the image and start the FilaMan container in the background.

### Accessing the Application

- **URL:** http://localhost:8000
- **Default Username:** `admin@example.com`
- **Default Password:** `admin123`

### Managing the Container
- **To stop the container:** `docker stop filaman-system-app`
- **To start the container again:** `docker start filaman-system-app`
- **To view logs:** `docker logs -f filaman-system-app`
- **To remove the container:** `docker rm filaman-system-app`

---

## Deutsch

### Voraussetzungen

- Sie müssen **Docker** auf Ihrem System installiert haben.

### Installationsschritte

**Schritt 1: Konfigurationsdatei (`.env`) erstellen**  
Zuerst müssen Sie eine Konfigurationsdatei anlegen, die alle Einstellungen speichert.

1.  Erstellen Sie einen neuen, leeren Ordner auf Ihrem Computer, in dem die Anwendungsdaten gespeichert werden sollen (z.B. `C:\FilaMan` oder `/home/user/filaman`).
2.  Erstellen Sie in diesem Ordner eine Datei mit dem Namen `.env`.
3.  Fügen Sie den folgenden Inhalt in diese Datei ein:

```env
# Es wird dringend empfohlen, diese aus Sicherheitsgründen zu ändern
SECRET_KEY=change-me-in-production-with-a-long-random-string
CSRF_SECRET_KEY=change-me-in-production-with-a-long-random-string

# Standard-Admin-Benutzer (wird beim ersten Start erstellt)
ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD=admin123
ADMIN_DISPLAY_NAME=Admin
ADMIN_LANGUAGE=en
ADMIN_SUPERADMIN=true

# Produktions-Einstellungen
DEBUG=false
CORS_ORIGINS=*
DATABASE_URL=sqlite+aiosqlite:////app/filaman.db
```
**Wichtig:** Aus Sicherheitsgründen sollten Sie die Standardwerte für `SECRET_KEY` und `CSRF_SECRET_KEY` durch lange, zufällige Zeichenketten ersetzen.

**Schritt 2: Anwendung mit Docker starten**  
Öffnen Sie nun ein Terminal oder eine Kommandozeile, navigieren Sie in den Ordner, den Sie gerade erstellt haben, und führen Sie den folgenden Befehl aus.

**Wichtig:** Sie müssen `ghcr.io/your-username/filaman-system:latest` durch den korrekten Image-Pfad ersetzen, den der Projektentwickler bereitstellt.

```bash
docker run -d \
  --name filaman-system-app \
  --restart unless-stopped \
  -p 8000:8000 \
  -v "$(pwd)/filaman.db":/app/filaman.db \
  --env-file .env \
  ghcr.io/your-username/filaman-system:latest
```

Docker wird nun das Image herunterladen und den FilaMan-Container im Hintergrund starten.

### Zugriff auf die Anwendung

- **URL:** http://localhost:8000
- **Standard-Benutzername:** `admin@example.com`
- **Standard-Passwort:** `admin123`

### Container verwalten
- **Container stoppen:** `docker stop filaman-system-app`
- **Container wieder starten:** `docker start filaman-system-app`
- **Logs ansehen:** `docker logs -f filaman-system-app`
- **Container entfernen:** `docker rm filaman-system-app`
