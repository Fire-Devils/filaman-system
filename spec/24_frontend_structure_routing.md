# 24 – Frontend Struktur und Routing (v1) – Astro + Tailwind, Static, Client Fetch

Status: final  
Version: v1  
Last Updated: 2026-02-13  

---

## 1) Zweck und Scope

Dieses Dokument beschreibt:
- Astro Ordnerstruktur
- Layout Komponenten (AppShell/Sidebar)
- Routing Strategie (Hybrid R3)
- Static Build serving durch Backend
- Client Fetch Prinzip (JS laedt Daten)

---

## 2) Entscheidungen (Decisions)

- Astro + Tailwind
- Static Build
- Hybrid Routing (R3): Astro Pages als Routen, Navigation via Links
- Daten werden clientseitig via fetch geladen (credentials include)
- Theme bleibt lokal (localStorage)

---

## 3) Ordnerstruktur (Vorschlag)

Siehe S2:
- src/pages/*
- src/layouts/*
- src/components/*
- src/lib/api/*

---

## 4) Static Serving durch Backend

- Astro build -> dist
- Backend served dist als static files
- Kein SPA Router, daher kein catch-all index fallback notwendig

---

## 5) Akzeptanzkriterien

- Astro build erzeugt dist
- Backend kann dist ausliefern
- Pages rufen API per fetch (credentials include) auf

---