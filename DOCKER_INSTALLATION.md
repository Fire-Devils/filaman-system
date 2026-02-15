# FilaMan Docker Installation

This guide explains how to install and run the FilaMan application using Docker.

---

## English

### Prerequisites

- You must have **Docker** and **Docker Compose** installed on your system.

### Installation Steps

1.  **Download the project**  
    Clone the repository to your local machine:  
    `git clone <repository_url>`  
    And navigate into the directory:  
    `cd FilaMan-System-opencode`

2.  **Create the Configuration File**  
    The application needs a configuration file to run.  
    - Find the file named `.env.example` in the main directory.  
    - **Create a copy** of this file and rename it to `.env`.  
    - You can leave the default values for the first start.

3.  **Start the Application**  
    Open your terminal in the project's main directory and run the following command:  
    `docker-compose up -d`  

    Docker will now download all necessary components and start the application in the background. This may take a few minutes on the first run.

### Accessing the Application

Once the container is running, you can access FilaMan in your web browser at:  
**http://localhost:8000**

### Default Admin Login

On the first start, a default administrator account is created for you:

-   **Username:** `admin@example.com`
-   **Password:** `admin123`

It is strongly recommended to change this password after your first login.

---

## Deutsch

### Voraussetzungen

- Sie müssen **Docker** und **Docker Compose** auf Ihrem System installiert haben.

### Installationsschritte

1.  **Projekt herunterladen**  
    Klonen Sie das Repository auf Ihren Computer:  
    `git clone <repository_url>`  
    Und wechseln Sie in das Verzeichnis:  
    `cd FilaMan-System-opencode`

2.  **Konfigurationsdatei erstellen**  
    Die Anwendung benötigt eine Konfigurationsdatei zum Starten.  
    - Im Hauptverzeichnis finden Sie die Datei `.env.example`.  
    - **Erstellen Sie eine Kopie** dieser Datei und benennen Sie sie in `.env` um.  
    - Für den ersten Start können Sie die Standardwerte beibehalten.

3.  **Anwendung starten**  
    Öffnen Sie Ihr Terminal im Hauptverzeichnis des Projekts und führen Sie den folgenden Befehl aus:  
    `docker-compose up -d`  

    Docker wird nun alle notwendigen Komponenten herunterladen und die Anwendung im Hintergrund starten. Beim ersten Mal kann dies einige Minuten dauern.

### Zugriff auf die Anwendung

Sobald der Container läuft, können Sie FilaMan in Ihrem Webbrowser unter folgender Adresse aufrufen:  
**http://localhost:8000**

### Standard-Admin-Login

Beim ersten Start wird ein Standard-Administratorkonto für Sie angelegt:

-   **Benutzername:** `admin@example.com`
-   **Passwort:** `admin123`

Es wird dringend empfohlen, dieses Passwort nach dem ersten Login zu ändern.
