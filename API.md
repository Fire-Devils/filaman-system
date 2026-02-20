# FilaMan API Documentation

This document provides a comprehensive overview of the FilaMan API endpoints, their functions, expected inputs, and response formats. This documentation is intended for both developers and AI agents.

---

## 1. Authentication

FilaMan supports three distinct authentication methods. All state-changing requests (POST, PUT, PATCH, DELETE) require authentication.

### 1.1 Session-based (Web Frontend)
Used primarily by the web interface.
- **Login**: `POST /auth/login` sets a `session_id` cookie.
- **Logout**: `POST /auth/logout` clears the session.
- **CSRF Protection**: For state-changing requests using session authentication, you MUST provide an `X-CSRF-Token` header. This header must match the value of the `csrf_token` cookie.

### 1.2 API Key (External Integrations)
For third-party tools or scripts.
- **Header**: `Authorization: ApiKey <your_api_key>`
- API keys can be managed in the user settings.

### 1.3 Device Token (Hardware)
For IoT devices like RFID readers or weighing scales.
- **Header**: `Authorization: Device <device_token>`
- Devices are registered via a device code or by an administrator.

---

## 2. General Concepts

### 2.1 Pagination
Listing endpoints typically support pagination via query parameters:
- `page`: Page number (integer, minimum: 1, default: 1)
- `page_size`: Items per page (integer, minimum: 1, maximum: 200, default: 50)

**Paginated Response Format:**
```json
{
  "items": [],
  "page": 1,
  "page_size": 50,
  "total": 100
}
```

### 2.2 Standard Responses
- **200 OK**: Request succeeded.
- **201 Created**: Resource created successfully.
- **204 No Content**: Request succeeded, no response body.
- **401 Unauthorized**: Authentication failed or missing.
- **403 Forbidden**: Insufficient permissions or CSRF failure.
- **404 Not Found**: The requested resource does not exist.
- **422 Unprocessable Entity**: Validation error. The body contains details about the failed fields.

---

## 3. API Endpoints

### 3.1 Authentication & Profile
| Method | Endpoint | Summary | Description |
| :--- | :--- | :--- | :--- |
| `POST` | `/auth/login` | Login | Exchanges email/password for a session. |
| `POST` | `/auth/logout` | Logout | Revokes the current session. |
| `GET` | `/auth/me` | Get Me | Returns details of the currently authenticated user. |
| `PATCH` | `/api/v1/me` | Update Me | Update profile details (display name, language). |
| `POST` | `/api/v1/me/change-password` | Change Password | Update the current user's password. |

### 3.2 Manufacturers
| Method | Endpoint | Summary |
| :--- | :--- | :--- |
| `GET` | `/api/v1/manufacturers` | List Manufacturers (Supports `page`, `page_size`) |
| `POST` | `/api/v1/manufacturers` | Create a new manufacturer. |
| `GET` | `/api/v1/manufacturers/{id}` | Get specific manufacturer details. |
| `PATCH` | `/api/v1/manufacturers/{id}` | Update manufacturer details. |
| `DELETE` | `/api/v1/manufacturers/{id}` | Delete a manufacturer. |

### 3.3 Colors
| Method | Endpoint | Summary |
| :--- | :--- | :--- |
| `GET` | `/api/v1/colors` | List shared colors. |
| `POST` | `/api/v1/colors` | Create a new color (hex code). |
| `GET` | `/api/v1/colors/{id}` | Get specific color. |
| `PATCH` | `/api/v1/colors/{id}` | Update color. |
| `DELETE` | `/api/v1/colors/{id}` | Delete color. |

### 3.4 Filaments
| Method | Endpoint | Summary |
| :--- | :--- | :--- |
| `GET` | `/api/v1/filaments` | List filaments. Filters: `type`, `manufacturer_id`. |
| `POST` | `/api/v1/filaments` | Create a filament type. |
| `GET` | `/api/v1/filaments/{id}` | Get detailed filament info. |
| `PATCH` | `/api/v1/filaments/{id}` | Update filament settings. |
| `DELETE` | `/api/v1/filaments/{id}` | Delete a filament. |
| `GET` | `/api/v1/filaments/types` | Returns a list of all material types used (e.g. PLA, PETG). |
| `PUT` | `/api/v1/filaments/{id}/colors` | Replace assigned colors for a filament. |

### 3.5 Spools
| Method | Endpoint | Summary | Description |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/v1/spools` | List Spools | Filters: `filament_id`, `status_id`, `location_id`, `manufacturer_id`. |
| `POST` | `/api/v1/spools` | Create Spool | Register a new physical spool. |
| `GET` | `/api/v1/spools/{id}` | Get Spool | Detailed status and remaining weight. |
| `PATCH` | `/api/v1/spools/{id}` | Update Spool | Modify metadata or manual overrides. |
| `POST` | `/api/v1/spools/{id}/measurements` | Record Measurement | Update weight via a scale reading. |
| `POST` | `/api/v1/spools/{id}/consumptions` | Record Consumption | Log used filament in grams. |
| `POST` | `/api/v1/spools/{id}/status` | Change Status | Transition between 'In Use', 'Empty', 'Stored', etc. |
| `POST` | `/api/v1/spools/{id}/move` | Move Location | Update the physical storage location. |
| `GET` | `/api/v1/spools/{id}/events` | List Events | Timeline of measurements, movements, and status changes. |

### 3.6 Printers & AMS Integration
| Method | Endpoint | Summary |
| :--- | :--- | :--- |
| `GET` | `/api/v1/printers` | List configured printers. |
| `POST` | `/api/v1/printers` | Add a new printer. |
| `GET` | `/api/v1/printers/{id}` | Get printer state. |
| `GET` | `/api/v1/printers/{id}/ams-units` | List AMS (Automatic Material System) units for this printer. |
| `GET` | `/api/v1/printers/{id}/slots` | List all material slots (AMS and manual) and their assigned spools. |

### 3.7 Admin & System
| Method | Endpoint | Summary |
| :--- | :--- | :--- |
| `GET/POST/PATCH` | `/api/v1/admin/users` | Manage system users. |
| `GET/POST/PATCH` | `/api/v1/admin/roles` | Manage RBAC roles and permissions. |
| `GET/POST/DELETE` | `/api/v1/admin/devices` | Manage hardware devices and rotate tokens. |
| `GET` | `/api/v1/admin/system/plugins` | List installed printer drivers/plugins. |
| `POST` | `/api/v1/admin/system/spoolman-import/execute` | Import data from an existing Spoolman instance. |
| `DELETE` | `/api/v1/admin/system/killswitch` | Emergency shutdown of backend tasks. |

---

## 4. Key Data Models

### Filament (Create)
- `manufacturer_id` (int): ID of the manufacturer.
- `designation` (string): Name of the product.
- `type` (string): Material (e.g., "PLA").
- `diameter_mm` (float): Usually 1.75 or 2.85.
- `default_spool_weight_g` (float): Weight of the empty spool (tare).
- `density_g_cm3` (float): Used to calculate length from weight.

### Spool (Create)
- `filament_id` (int): Reference to a filament type.
- `initial_total_weight_g` (float): Weight of spool + filament when new.
- `empty_spool_weight_g` (float): Weight of the empty spool.
- `rfid_uid` (string, optional): ID for RFID tracking.
- `location_id` (int, optional): Where the spool is stored.

---

## 5. Health Checks
- `GET /health`: Returns `{"status": "ok"}` if the service is running.
- `GET /health/ready`: Checks Database and Plugin manager status. Returns 200 if everything is ready, otherwise 503.
