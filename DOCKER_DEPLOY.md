# How to Install FilaMan via Docker

This guide explains how to run the FilaMan application using the pre-built Docker image from the GitHub Container Registry (ghcr.io). No programming knowledge is required.

---

## English

### Prerequisites

- You must have **Docker** and **Docker Compose** installed on your system.

### Installation Steps

**Step 1: Create a Folder**  
Create a new, empty folder on your computer where you want to store the application data. For example, `C:\FilaMan` or `/home/user/filaman`.

**Step 2: Create the `docker-compose.yml` File**  
Inside the new folder, create a file named `docker-compose.yml` and paste the following content into it:

```yaml
version: '3.8'

services:
  filaman:
    # IMPORTANT: Replace the image path with the actual image path
    # Example: ghcr.io/your-username/filaman-system:latest
    image: ghcr.io/YOUR_GITEA_USERNAME/filaman-system:latest
    container_name: filaman-system-app
    restart: unless-stopped
    ports:
      - "8000:8000"
    volumes:
      - ./filaman.db:/app/filaman.db
    env_file:
      - .env

networks:
  default:
    name: filaman-network
```
**Important:** You must replace `ghcr.io/YOUR_GITEA_USERNAME/filaman-system:latest` with the correct image path provided by the project developer.

**Step 3: Create the `.env` Configuration File**  
In the same folder, create another file named `.env`. This file holds the configuration. Paste the content below into this file.

```env
# It is strongly recommended to change these default keys for security
SECRET_KEY=change-me-in-production
CSRF_SECRET_KEY=change-me-in-production

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
For security, you should replace the default values for `SECRET_KEY` and `CSRF_SECRET_KEY` with long, random strings.

**Step 4: Start the Application**  
Open a terminal or command prompt, navigate into the folder you created, and run the following command:  
`docker-compose up -d`

Docker will now download the FilaMan image and start the application.

### Accessing the Application

Once the container is running, you can access FilaMan in your web browser at:  
**http://localhost:8000**

### Default Admin Login

-   **Username:** `admin@example.com`
-   **Password:** `admin123`

---

## Deutsch

### Voraussetzungen

- Sie müssen **Docker** und **Docker Compose** auf Ihrem System installiert haben.

### Installationsschritte

**Schritt 1: Ordner erstellen**  
Erstellen Sie einen neuen, leeren Ordner auf Ihrem Computer, in dem Sie die Anwendungsdaten speichern möchten. Zum Beispiel `C:\FilaMan` oder `/home/user/filaman`.

**Schritt 2: `docker-compose.yml`-Datei erstellen**  
Erstellen Sie in dem neuen Ordner eine Datei mit dem Namen `docker-compose.yml` und fügen Sie den folgenden Inhalt ein:

```yaml
version: '3.8'

services:
  filaman:
    # WICHTIG: Ersetzen Sie den Image-Pfad mit dem tatsächlichen Pfad
    # Beispiel: ghcr.io/ihr-benutzername/filaman-system:latest
    image: ghcr.io/YOUR_GITEA_USERNAME/filaman-system:latest
    container_name: filaman-system-app
    restart: unless-stopped
    ports:
      - "8000:8000"
    volumes:
      - ./filaman.db:/app/filaman.db
    env_file:
      - .env

networks:
  default:
    name: filaman-network
```
**Wichtig:** Sie müssen `ghcr.io/YOUR_GITEA_USERNAME/filaman-system:latest` durch den korrekten Image-Pfad ersetzen, den der Projektentwickler bereitstellt.

**Schritt 3: `.env`-Konfigurationsdatei erstellen**  
Erstellen Sie im selben Ordner eine weitere Datei mit dem Namen `.env`. Diese Datei enthält die Konfiguration. Fügen Sie den folgenden Inhalt ein.

```env
# Es wird dringend empfohlen, diese Standardschlüssel aus Sicherheitsgründen zu ändern
SECRET_KEY=change-me-in-production
CSRF_SECRET_KEY=change-me-in-production

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
Aus Sicherheitsgründen sollten Sie die Standardwerte für `SECRET_KEY` und `CSRF_SECRET_KEY` durch lange, zufällige Zeichenketten ersetzen.

**Schritt 4: Anwendung starten**  
Öffnen Sie ein Terminal oder eine Kommandozeile, navigieren Sie in den von Ihnen erstellten Ordner und führen Sie diesen Befehl aus:  
`docker-compose up -d`

Docker wird nun das FilaMan-Image herunterladen und die Anwendung starten.

### Zugriff auf die Anwendung

Sobald der Container läuft, können Sie FilaMan in Ihrem Webbrowser unter folgender Adresse aufrufen:  
**http://localhost:8000**

### Standard-Admin-Login

-   **Benutzername:** `admin@example.com`
-   **Passwort:** `admin123`
