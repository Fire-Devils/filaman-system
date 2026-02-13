# 11 – Backend Logging und Health (v1)

Status: final  
Version: v1  
Last Updated: 2026-02-13  

---

## 1) Zweck und Scope

Dieses Dokument spezifiziert:
- Logging (Python logging, JSON Format)
- Request Correlation ID (request_id)
- Health Endpoints:
  - /health (liveness)
  - /health/ready (readiness)
  - optional plugin health

Nicht Teil dieses Dokuments
- Auth/RBAC (siehe 08)
- REST API Ressourcen (siehe 12+)

---

## 2) Abhaengigkeiten

- Plugin Runtime (06) fuer plugin health
- DB (alle Domains) fuer readiness DB check

---

## 3) Entscheidungen (Decisions)

- Logging: L1 (python logging + JSON formatter)
- Health:
  - /health unauthenticated
  - /health/ready unauthenticated, liefert 503 wenn nicht ready
  - plugin details optional ueber authenticated admin endpoint

---

## 4) Logging

### 4.1 ENV
- LOG_LEVEL (default INFO)
- LOG_FORMAT (default json)

### 4.2 JSON Felder (Empfehlung)
- timestamp
- level
- logger
- message
- request_id (wenn vorhanden)
- user_id (wenn vorhanden)
- device_id (wenn vorhanden)
- method, path, status_code (access log)
- duration_ms (access log)
- exception (stacktrace, wenn error)

### 4.3 Request ID
- Middleware generiert UUID request_id pro Request
- optional: uebernimmt X-Request-Id Header (wenn vorhanden)
- request_id wird in alle Logs injiziert (LoggerAdapter oder contextvars)

### 4.4 Sensitive Data
- Tokens, Passwoerter, secrets niemals loggen
- rfid_uid/external_id sparsam loggen (optional maskieren)

---

## 5) Health Endpoints

### 5.1 GET /health
Zweck
- Liveness Probe (Prozess lebt)

Response 200
    { "status": "ok" }

### 5.2 GET /health/ready
Zweck
- Readiness Probe (DB erreichbar, plugin runtime gestartet)

Checks (v1)
- DB: SELECT 1
- Seeds executed (optional flag)
- Plugin manager initialisiert (manager up)

Response 200
    { "status": "ok", "db": "ok", "plugins": "ok" }

Wenn nicht ready
- 503 Service Unavailable
    { "status": "not_ready", "db": "fail", "plugins": "ok" }

### 5.3 Optional: Plugin Health API
GET /api/v1/admin/health/plugins

Auth
- printers:read oder admin:devices_manage (Policy)
Response
- Liste printer_id + driver_key + health dict

---

## 6) Akzeptanzkriterien

- Logs sind JSON und enthalten request_id
- /health liefert 200
- /health/ready liefert 200 wenn DB ok, sonst 503
- Keine Secrets im Log

---