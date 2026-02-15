# How to Install FilaMan via Docker Command

This guide explains how to run the FilaMan application using a single Docker command. This is the recommended method for simple deployments.

---

## English

### Prerequisites

- You must have **Docker** installed on your system.

Open a terminal or command prompt, navigate into the folder you just created, and run the command below.

```bash
docker run -d \
  --name filaman-system-app \
  --restart unless-stopped \
  -p 8000:8000 \
  -v "$(pwd)/filaman.db":/app/filaman.db \
  ghcr.io/fire-devils/filaman-system:latest
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

Öffnen Sie nun ein Terminal oder eine Kommandozeile, navigieren Sie in den Ordner, den Sie gerade erstellt haben, und führen Sie den folgenden Befehl aus.

```bash
docker run -d \
  --name filaman-system-app \
  --restart unless-stopped \
  -p 8000:8000 \
  -v "$(pwd)/filaman.db":/app/filaman.db \
  ghcr.io/fire-devils/filaman-system:latest
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
