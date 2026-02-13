# 23 – Frontend IA + Wireframes (v1)

Status: final  
Version: v1  
Last Updated: 2026-02-13  

---

## 1) Zweck und Scope

Dieses Dokument beschreibt:
- Informationsarchitektur (Navigation, Seiten)
- Wireframe-/Screenliste (funktional)
- Kernfelder je Seite und Aktionen

Nicht Teil
- Astro Projektstruktur (siehe 24)
- Auth/CSRF flow (siehe 25)
- i18n (siehe 26)

---

## 2) Navigation (Sidebar L1)

Hauptnavigation
- Dashboard
- Filamente
- Spulen
- Lagerorte
- Einstellungen

Admin Bereich (unter Admin)
- Users
- Roles
- Permissions
- Devices
- Printers & AMS

Sidebar Features
- collapsed (nur Icons) / expanded (Icons + Text)
- Zustand in localStorage

---

## 3) Screens (Kurz)

- /login
- /dashboard
- /filaments (list)
- /filaments/new
- /filaments/[id] (tabs: details, colors, profiles, ratings)
- /spools (list)
- /spools/new
- /spools/[id] (tabs: overview, events, weight/adjust, status/location)
- /locations (list)
- /settings (profile, theme local, change password)
- /admin/users, /admin/roles, /admin/permissions, /admin/devices, /admin/printers (+ /ams)

Details: siehe W1 Wireframe-Liste (im Chat konsolidiert).

---

## 4) Permission Gating (UI)

- UI laedt /api/v1/me und nutzt permissions set
- Admin Section nur anzeigen, wenn irgendein admin/printers permission existiert

---

## 5) Akzeptanzkriterien

- Alle Screens sind im Routing vorhanden
- Actions passen zu API Endpoints
- Permission gating blendet Menues/Buttons aus

---