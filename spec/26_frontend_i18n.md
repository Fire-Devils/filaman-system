# 26 – Frontend i18n (v1) – de/en

Status: final  
Version: v1  
Last Updated: 2026-02-13  

---

## 1) Zweck und Scope

Dieses Dokument beschreibt:
- Dictionaries fuer de/en
- Key-Konvention
- Loader + translator helper
- Nutzung von users.language aus /api/v1/me

---

## 2) Entscheidungen (Decisions)

- Sprachen: de, en
- Quelle: users.language
- Fallback: en
- Theme: lokal (nicht in user gespeichert)

---

## 3) Struktur

- src/i18n/en.json
- src/i18n/de.json
- lib/i18n loader + t(key)

---

## 4) Sprache aendern

- Settings -> PATCH /api/v1/me { language }
- UI reload oder dict neu laden

---

## 5) Akzeptanzkriterien

- Navigation/Buttons/Standardtexte uebersetzbar
- Sprache folgt users.language

---