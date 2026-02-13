# 25 – Frontend Auth und CSRF Flow (v1)

Status: final  
Version: v1  
Last Updated: 2026-02-13  

---

## 1) Zweck und Scope

Dieses Dokument beschreibt:
- Wie das Frontend sich einloggt (Session Cookie)
- Wie /api/v1/me genutzt wird
- Wie CSRF Token gelesen und als Header gesetzt wird
- Logout Flow

---

## 2) Login Flow

- UI POST /auth/login (email, password)
- Backend setzt:
  - Cookie session_id (HttpOnly)
  - Cookie csrf_token (nicht HttpOnly)

Nach login
- redirect /dashboard
- UI laedt /api/v1/me

---

## 3) API Calls

- credentials: include
- mutating /api/v1 calls:
  - header X-CSRF-Token = csrf_token cookie value

Error Handling
- 401 -> redirect /login
- 403 -> toast "Not allowed"
- 409 -> toast conflict
- 422 -> field errors anzeigen

---

## 4) Logout

- UI POST /auth/logout
- Backend revoked session + clears cookies
- UI redirect /login

---

## 5) Akzeptanzkriterien

- Mutating calls ohne CSRF werden geblockt (403)
- Mutating calls mit CSRF funktionieren
- /api/v1/me steuert permission gating

---