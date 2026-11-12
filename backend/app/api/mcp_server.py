"""MCP server (Model Context Protocol) for AI assistants.

Implements the stateless "Streamable HTTP" transport: every JSON-RPC request is
a POST to ``/mcp`` that is answered with a single JSON response. No sessions and
no server-sent events are needed, which keeps the endpoint safe for multiple
Gunicorn workers.

Security model:
- Only ``Authorization: ApiKey <key>`` principals are accepted. The key's user
  roles and scopes apply unchanged.
- Native tools forward to the regular REST API (in-process, via ASGI) with the
  caller's Authorization header, so ``RequirePermission``, validation and
  spool events behave exactly like a normal API client.
- Allowlisted plugin tools call their registered handler after the host checks the
  tool's declared read permission.
- The admin switches ``mcp_enabled`` and ``mcp_write_enabled`` (app settings)
  turn the whole endpoint, respectively the write tools, on or off.
"""

from __future__ import annotations

import json
import logging
from asyncio import timeout
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse, Response
from sqlalchemy import select

from app.api.mcp_plugin_tools import (
    InvalidPluginToolArguments,
    available_plugin_read_tools,
    call_plugin_read_tool,
)
from app.api.v1.schemas_filament import FilamentCreate, FilamentUpdate
from app.core import database
from app.core.config import settings
from app.models import AppSettings

logger = logging.getLogger(__name__)

router = APIRouter(tags=["mcp"])

SUPPORTED_PROTOCOL_VERSIONS = ("2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05")
LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0]
SERVER_NAME = "filaman"
MAX_RESULT_CHARS = 60_000
MCP_BATCH_TIMEOUT_SECONDS = 90  # Leave time to serialize the response before Nginx's 120-second deadline.

INSTRUCTIONS = (
    "FilaMan manages 3D-printing filament: manufacturers, filaments (material "
    "type, colour, diameter), spools (physical rolls with remaining weight, "
    "status and storage location), locations and printers. Weights are in "
    "grams. Use list_spool_statuses and list_locations to resolve names to "
    "ids before changing a spool. Write tools are only listed when the "
    "administrator has allowed write access."
)

# JSON-RPC error codes
PARSE_ERROR = -32700
INVALID_REQUEST = -32600
METHOD_NOT_FOUND = -32601
INVALID_PARAMS = -32602
BATCH_DEADLINE_EXCEEDED = -32000


class ApiCaller:
    """Calls the FilaMan REST API in-process with the MCP client's credentials."""

    def __init__(self, request: Request) -> None:
        self._app = request.app
        self._headers = {"Authorization": request.headers.get("authorization", "")}

    async def __call__(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        json_body: Any = None,
    ) -> tuple[int, Any]:
        clean_params = {k: v for k, v in (params or {}).items() if v is not None}
        transport = httpx.ASGITransport(app=self._app)
        async with httpx.AsyncClient(transport=transport, base_url="http://filaman.internal") as client:
            resp = await client.request(
                method, f"/api/v1{path}", params=clean_params, json=json_body, headers=self._headers
            )
        if resp.status_code == 204 or not resp.content:
            return resp.status_code, None
        try:
            return resp.status_code, resp.json()
        except ValueError:
            return resp.status_code, resp.text


Handler = Callable[[dict[str, Any], ApiCaller], Awaitable[tuple[int, Any]]]


@dataclass(frozen=True)
class Tool:
    name: str
    description: str
    input_schema: dict[str, Any]
    handler: Handler
    write: bool = False

    def descriptor(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "description": self.description,
            "inputSchema": self.input_schema,
            "annotations": {
                "readOnlyHint": not self.write,
                "destructiveHint": False,
                "openWorldHint": False,
            },
        }


def _schema(properties: dict[str, Any] | None = None, required: list[str] | None = None) -> dict[str, Any]:
    schema: dict[str, Any] = {
        "type": "object",
        "properties": properties or {},
        "additionalProperties": False,
    }
    if required:
        schema["required"] = required
    return schema


_INT = {"type": "integer", "minimum": 1}
_PAGE = {"type": "integer", "minimum": 1, "description": "Page number (default 1)"}
_PAGE_SIZE = {"type": "integer", "minimum": 1, "maximum": 200, "description": "Items per page (default 50)"}
_NOTE = {"type": "string", "maxLength": 1000, "description": "Optional note stored with the event"}
_PAGING = {"page": _PAGE, "page_size": _PAGE_SIZE}
_COLOR_ENTRIES = {
    "type": "array",
    "items": {
        "type": "object",
        "properties": {
            "color_id": _INT,
            "position": {"type": "integer", "minimum": 1, "description": "Order, starting at 1"},
            "display_name_override": {"type": "string"},
        },
        "required": ["color_id"],
        "additionalProperties": False,
    },
}


def _pick(args: dict[str, Any], *keys: str) -> dict[str, Any]:
    return {k: args[k] for k in keys if k in args}


def _get(path: str, *query_keys: str) -> Handler:
    async def handler(args: dict[str, Any], api: ApiCaller) -> tuple[int, Any]:
        return await api("GET", path.format(**args), params=_pick(args, *query_keys))

    return handler


def _post(path: str, *body_keys: str) -> Handler:
    async def handler(args: dict[str, Any], api: ApiCaller) -> tuple[int, Any]:
        return await api("POST", path.format(**args), json_body=_pick(args, *body_keys))

    return handler


async def _update_spool(args: dict[str, Any], api: ApiCaller) -> tuple[int, Any]:
    return await api("PATCH", f"/spools/{args['spool_id']}", json_body=args.get("fields", {}))


async def _update_filament(args: dict[str, Any], api: ApiCaller) -> tuple[int, Any]:
    return await api("PATCH", f"/filaments/{args['filament_id']}", json_body=args.get("fields", {}))


async def _set_filament_colors(args: dict[str, Any], api: ApiCaller) -> tuple[int, Any]:
    body = _pick(args, "color_mode", "multi_color_style", "colors")
    return await api("PUT", f"/filaments/{args['filament_id']}/colors", json_body=body)


async def _update_location(args: dict[str, Any], api: ApiCaller) -> tuple[int, Any]:
    return await api("PATCH", f"/locations/{args['location_id']}", json_body=args.get("fields", {}))


async def _update_manufacturer(args: dict[str, Any], api: ApiCaller) -> tuple[int, Any]:
    return await api("PATCH", f"/manufacturers/{args['manufacturer_id']}", json_body=args.get("fields", {}))


def _print_request(target: str) -> Handler:
    async def handler(args: dict[str, Any], api: ApiCaller) -> tuple[int, Any]:
        return await api("POST", f"/labels/{target}/{args[target + '_id']}/print-request",
                         params=_pick(args, "preset_id"))

    return handler


_PREPARE_KEYS = (
    "manufacturer_name", "manufacturer_website", "designation", "material_key", "material_name",
    "material_subtype", "manufacturer_color_name", "diameter_mm", "density_g_cm3", "temp_nozzle_min",
    "temp_nozzle_max", "temp_bed", "nominal_weight_g", "price", "currency", "shop_url", "color_mode",
    "multi_color_style", "colors",
)


async def _prepare_filamentdb_filament(args: dict[str, Any], api: ApiCaller) -> tuple[int, Any]:
    return await api("POST", "/filamentdb/prepare-filament", json_body=_pick(args, *_PREPARE_KEYS))


async def _import_filamentdb_filament(args: dict[str, Any], api: ApiCaller) -> tuple[int, Any]:
    """Prepare (find/create manufacturer + colours) and then create the local filament."""
    status_code, prepared = await _prepare_filamentdb_filament(args, api)
    if status_code >= 400:
        return status_code, prepared
    allowed = set(FilamentCreate.model_fields)
    body = {k: v for k, v in prepared["prefilled"].items() if k in allowed and v is not None}
    if not body.get("material_type"):
        return 400, {"detail": "The catalogue record has no material (material_key / material_name)"}
    color_ids = prepared.get("color_ids") or []
    if color_ids:
        body["colors"] = [{"color_id": cid, "position": i} for i, cid in enumerate(color_ids, start=1)]
        if len(color_ids) > 1:
            body["color_mode"] = "multi"
            body.setdefault("multi_color_style", "striped")
    status_code, filament = await api("POST", "/filaments", json_body=body)
    if status_code >= 400:
        return status_code, filament
    return status_code, {
        "filament": filament,
        "manufacturer_created": prepared["manufacturer_created"],
        "colors_created": prepared["colors_created"],
    }


_SPOOL_LIST_KEYS = (
    "search", "filament_id", "status_id", "location_id", "manufacturer_id", "type",
    "remaining_percent_min", "remaining_percent_max", "include_archived", "sort_by",
    "sort_order", "page", "page_size",
)

_SPOOL_FIELDS = {
    "status_id": _INT,
    "location_id": _INT,
    "lot_number": {"type": "string"},
    "external_id": {"type": "string"},
    "purchase_date": {"type": "string", "format": "date-time"},
    "purchase_price": {"type": "number", "minimum": 0},
    "initial_total_weight_g": {"type": "number", "minimum": 0, "description": "Gross weight incl. empty spool"},
    "empty_spool_weight_g": {"type": "number", "minimum": 0},
    "remaining_weight_g": {"type": "number", "minimum": 0, "description": "Net filament weight left"},
}

TOOLS: tuple[Tool, ...] = (
    # ---- read ----------------------------------------------------------------
    Tool(
        "list_spools",
        "List spools with remaining weight, filament, status and location. Supports full-text search "
        "(manufacturer, material, colour, lot, extra fields) and filters. Archived spools are hidden "
        "unless include_archived is true.",
        _schema({
            "search": {"type": "string", "maxLength": 200},
            "filament_id": {"type": "array", "items": _INT},
            "status_id": {"type": "array", "items": _INT},
            "location_id": {"type": "array", "items": _INT},
            "manufacturer_id": {"type": "array", "items": _INT},
            "type": {"type": "array", "items": {"type": "string"}, "description": "Material types, e.g. PLA"},
            "remaining_percent_min": {"type": "number", "minimum": 0, "maximum": 100},
            "remaining_percent_max": {"type": "number", "minimum": 0, "maximum": 100},
            "include_archived": {"type": "boolean"},
            "sort_by": {"type": "string", "enum": [
                "id", "remaining_weight_g", "remaining_percent", "last_used_at", "created_at",
                "purchase_date", "purchase_price", "manufacturer", "material", "mfr_color",
            ]},
            "sort_order": {"type": "string", "enum": ["asc", "desc"]},
            **_PAGING,
        }),
        _get("/spools", *_SPOOL_LIST_KEYS),
    ),
    Tool("get_spool", "Get one spool with all details.", _schema({"spool_id": _INT}, ["spool_id"]),
         _get("/spools/{spool_id}")),
    Tool(
        "list_filaments",
        "List filament definitions (manufacturer, designation, material type, colours, diameter, price).",
        _schema({
            "search": {"type": "string", "maxLength": 200},
            "type": {"type": "array", "items": {"type": "string"}},
            "manufacturer_id": {"type": "array", "items": _INT},
            **_PAGING,
        }),
        _get("/filaments", "search", "type", "manufacturer_id", "page", "page_size"),
    ),
    Tool("get_filament", "Get one filament definition with all details.",
         _schema({"filament_id": _INT}, ["filament_id"]), _get("/filaments/{filament_id}")),
    Tool("list_material_types", "List all material types in use (PLA, PETG, …).", _schema(),
         _get("/filaments/types")),
    Tool("list_colors", "List known colours (id, name, hex code) with their usage count. A spool's displayed "
         "colour comes from the colours assigned to its filament (see set_filament_colors).",
         _schema(_PAGING), _get("/colors", "page", "page_size")),
    Tool("list_manufacturers", "List manufacturers.", _schema(_PAGING),
         _get("/manufacturers", "page", "page_size")),
    Tool("list_locations", "List storage locations with their spool count.", _schema(_PAGING),
         _get("/locations", "page", "page_size")),
    Tool("list_spool_statuses", "List spool statuses (id and key, e.g. new, opened, empty, archived).",
         _schema(), _get("/spools/statuses")),
    Tool("list_printers", "List printers.", _schema(_PAGING), _get("/printers", "page", "page_size")),
    Tool("get_printer", "Get one printer including its slots and loaded spools.",
         _schema({"printer_id": _INT}, ["printer_id"]), _get("/printers/{printer_id}")),
    Tool("get_dashboard_stats", "Inventory totals: spool counts, total and remaining weight, value.",
         _schema(), _get("/dashboard/stats")),
    Tool(
        "list_spool_events",
        "List spool history events (measurements, consumption, moves, status changes), newest first.",
        _schema({"search": {"type": "string", "maxLength": 200}, **_PAGING}),
        _get("/spools/all-events", "search", "page", "page_size"),
    ),
    Tool(
        "get_spool_events",
        "List the history events of one spool (measurements, consumption, adjustments, moves, status "
        "changes), newest first.",
        _schema({"spool_id": _INT, **_PAGING}, ["spool_id"]),
        _get("/spools/{spool_id}/events", "page", "page_size"),
    ),
    Tool(
        "search_filamentdb_filaments",
        "Search the FilamentDB community catalogue (an external database of manufacturer filaments, not the "
        "local inventory). Results are catalogue records; to add one to FilaMan pass its data to "
        "import_filamentdb_filament. Filter by search text, manufacturer name or id, or material key.",
        _schema({
            "search": {"type": "string", "minLength": 1, "maxLength": 200},
            "manufacturer_id": {"type": "integer", "minimum": 1, "description": "FilamentDB manufacturer id"},
            "manufacturer_name": {"type": "string", "minLength": 2, "description": "Resolved to a FilamentDB id"},
            "material_key": {"type": "string", "description": "e.g. pla, petg"},
            "page": _PAGE,
            "page_size": {"type": "integer", "minimum": 1, "maximum": 100, "description": "Items per page (default 20)"},
        }),
        _get("/filamentdb/filaments", "search", "manufacturer_id", "manufacturer_name", "material_key",
             "page", "page_size"),
    ),
    Tool(
        "list_filamentdb_manufacturers",
        "Search manufacturers in the FilamentDB community catalogue (external, not the local manufacturers).",
        _schema({
            "search": {"type": "string", "minLength": 1, "maxLength": 200},
            "page": _PAGE,
            "page_size": {"type": "integer", "minimum": 1, "maximum": 100, "description": "Items per page (default 20)"},
        }),
        _get("/filamentdb/manufacturers", "search", "page", "page_size"),
    ),
    # ---- write ---------------------------------------------------------------
    Tool(
        "import_filamentdb_filament",
        "Import a filament from the FilamentDB catalogue in one step: finds or creates the local manufacturer "
        "and colours, then creates the local filament with colours set. Fill the arguments from a record "
        "returned by search_filamentdb_filaments (manufacturer_name, designation, material_key or "
        "material_name, colours as hex_code/color_name). Returns the new filament; add spools afterwards "
        "with create_spool or create_spools_bulk. Check list_filaments first to avoid duplicates.",
        _schema({
            "manufacturer_name": {"type": "string", "minLength": 1},
            "manufacturer_website": {"type": "string"},
            "designation": {"type": "string", "minLength": 1},
            "material_key": {"type": "string"},
            "material_name": {"type": "string", "description": "Preferred over material_key for material_type"},
            "material_subtype": {"type": "string"},
            "manufacturer_color_name": {"type": "string"},
            "diameter_mm": {"type": "number", "exclusiveMinimum": 0},
            "density_g_cm3": {"type": "number", "exclusiveMinimum": 0},
            "temp_nozzle_min": {"type": "number"},
            "temp_nozzle_max": {"type": "number"},
            "temp_bed": {"type": "number"},
            "nominal_weight_g": {"type": "integer", "minimum": 0, "description": "Filament weight per spool"},
            "price": {"type": "number", "minimum": 0},
            "currency": {"type": "string", "description": "ISO code, e.g. EUR"},
            "shop_url": {"type": "string"},
            "color_mode": {"type": "string", "enum": ["single", "multi"]},
            "multi_color_style": {"type": "string", "enum": ["striped", "gradient"]},
            "colors": {
                "type": "array",
                "items": _schema({
                    "hex_code": {"type": "string", "description": "e.g. #FF0000"},
                    "color_name": {"type": "string"},
                    "position": {"type": "integer", "minimum": 1},
                }, ["hex_code"]),
            },
        }, ["manufacturer_name", "designation"]),
        _import_filamentdb_filament,
        write=True,
    ),
    Tool(
        "create_spools_bulk",
        "Create several identical spools of one filament at once (quantity 1-100). All spools get the same "
        "optional fields (status, location, lot, price, weights).",
        _schema({"filament_id": _INT, "quantity": {"type": "integer", "minimum": 1, "maximum": 100},
                 **_SPOOL_FIELDS}, ["filament_id", "quantity"]),
        _post("/spools/bulk", "filament_id", "quantity", *_SPOOL_FIELDS.keys()),
        write=True,
    ),
    Tool(
        "record_spool_adjustment",
        "Correct the remaining weight of a spool (e.g. the stored value was wrong). This is a correction, not "
        "consumption: use record_spool_consumption for filament that was used. adjustment_type relative needs "
        "delta_weight_g (positive or negative change of the remaining weight); absolute needs "
        "measured_weight_g (gross weight incl. empty spool).",
        _schema({
            "spool_id": _INT,
            "adjustment_type": {"type": "string", "enum": ["relative", "absolute"]},
            "delta_weight_g": {"type": "number", "description": "For relative; may be negative"},
            "measured_weight_g": {"type": "number", "minimum": 0, "description": "For absolute"},
            "note": _NOTE,
        }, ["spool_id", "adjustment_type"]),
        _post("/spools/{spool_id}/adjustments", "adjustment_type", "delta_weight_g", "measured_weight_g", "note"),
        write=True,
    ),
    Tool(
        "update_location",
        "Rename a storage location or change its identifier.",
        _schema({
            "location_id": _INT,
            "fields": _schema({"name": {"type": "string", "minLength": 1}, "identifier": {"type": "string"}}),
        }, ["location_id", "fields"]),
        _update_location,
        write=True,
    ),
    Tool(
        "update_manufacturer",
        "Change manufacturer data (name, website, default empty-spool weight and spool dimensions).",
        _schema({
            "manufacturer_id": _INT,
            "fields": _schema({
                "name": {"type": "string", "minLength": 1},
                "url": {"type": "string"},
                "empty_spool_weight_g": {"type": "number", "minimum": 0},
                "spool_outer_diameter_mm": {"type": "number", "minimum": 0},
                "spool_width_mm": {"type": "number", "minimum": 0},
                "spool_material": {"type": "string"},
            }),
        }, ["manufacturer_id", "fields"]),
        _update_manufacturer,
        write=True,
    ),
    Tool(
        "request_spool_label_print",
        "Queue a label print job for a spool. The job is shown to the user's logged-in FilaMan session / "
        "connected label printer, which then prints it; nothing is printed directly by this call. "
        "Optional preset_id picks a label preset (default: the user's selected preset).",
        _schema({"spool_id": _INT, "preset_id": {"type": "integer", "minimum": 0}}, ["spool_id"]),
        _print_request("spool"),
        write=True,
    ),
    Tool(
        "request_filament_label_print",
        "Queue a label print job for a filament definition. The job is shown to the user's logged-in FilaMan "
        "session / connected label printer, which then prints it; nothing is printed directly by this call. "
        "Optional preset_id picks a label preset (default: the user's selected preset).",
        _schema({"filament_id": _INT, "preset_id": {"type": "integer", "minimum": 0}}, ["filament_id"]),
        _print_request("filament"),
        write=True,
    ),
    Tool(
        "create_spool",
        "Create a new spool for an existing filament. The colour is not a spool property: it lives on the "
        "filament, so set it when creating the filament (create_filament with colors) or later with "
        "set_filament_colors (colours via list_colors / create_color).",
        _schema({"filament_id": _INT, **_SPOOL_FIELDS}, ["filament_id"]),
        _post("/spools", "filament_id", *_SPOOL_FIELDS.keys()),
        write=True,
    ),
    Tool(
        "update_spool",
        "Change spool master data (lot, price, weights, …). For weighing, consumption, status or "
        "location use the dedicated tools so the spool history stays correct.",
        _schema({
            "spool_id": _INT,
            "fields": _schema({k: v for k, v in _SPOOL_FIELDS.items() if k not in ("status_id", "location_id")}),
        }, ["spool_id", "fields"]),
        _update_spool,
        write=True,
    ),
    Tool(
        "record_spool_measurement",
        "Record a scale reading (gross weight incl. empty spool) for a spool; the remaining weight is recalculated.",
        _schema({"spool_id": _INT, "measured_weight_g": {"type": "number", "minimum": 0}, "note": _NOTE},
                ["spool_id", "measured_weight_g"]),
        _post("/spools/{spool_id}/measurements", "measured_weight_g", "note"),
        write=True,
    ),
    Tool(
        "record_spool_consumption",
        "Book filament consumption in grams (e.g. after a print).",
        _schema({"spool_id": _INT, "delta_weight_g": {"type": "number", "exclusiveMinimum": 0}, "note": _NOTE},
                ["spool_id", "delta_weight_g"]),
        _post("/spools/{spool_id}/consumptions", "delta_weight_g", "note"),
        write=True,
    ),
    Tool(
        "change_spool_status",
        "Change the status of a spool by status key (see list_spool_statuses), e.g. to archive it.",
        _schema({"spool_id": _INT, "status": {"type": "string"}, "note": _NOTE}, ["spool_id", "status"]),
        _post("/spools/{spool_id}/status", "status", "note"),
        write=True,
    ),
    Tool(
        "move_spool",
        "Move a spool to another storage location. Pass location_id null to unassign.",
        _schema({"spool_id": _INT, "location_id": {"type": ["integer", "null"], "minimum": 1}, "note": _NOTE},
                ["spool_id", "location_id"]),
        _post("/spools/{spool_id}/move", "location_id", "note"),
        write=True,
    ),
    Tool(
        "create_location",
        "Create a storage location.",
        _schema({"name": {"type": "string", "minLength": 1}, "identifier": {"type": "string"}}, ["name"]),
        _post("/locations", "name", "identifier"),
        write=True,
    ),
    Tool(
        "create_manufacturer",
        "Create a manufacturer.",
        _schema({
            "name": {"type": "string", "minLength": 1},
            "url": {"type": "string"},
            "empty_spool_weight_g": {"type": "number", "minimum": 0},
        }, ["name"]),
        _post("/manufacturers", "name", "url", "empty_spool_weight_g"),
        write=True,
    ),
    Tool(
        "create_filament",
        "Create a filament definition for an existing manufacturer. Colours can be set directly here via "
        "colors (colour ids from list_colors / create_color; color_mode single with one colour, or multi "
        "with several plus multi_color_style); without colors the filament has no colour. Use "
        "set_filament_colors to change colours later. manufacturer_color_name is only a label.",
        _schema({
            "manufacturer_id": _INT,
            "designation": {"type": "string", "minLength": 1},
            "material_type": {"type": "string", "minLength": 1},
            "diameter_mm": {"type": "number", "exclusiveMinimum": 0, "description": "Usually 1.75"},
            "manufacturer_color_name": {"type": "string"},
            "finish_type": {"type": "string"},
            "raw_material_weight_g": {"type": "number", "minimum": 0},
            "default_spool_weight_g": {"type": "number", "minimum": 0},
            "price": {"type": "number", "minimum": 0},
            "shop_url": {"type": "string"},
            "density_g_cm3": {"type": "number", "exclusiveMinimum": 0},
            "color_mode": {"type": "string", "enum": ["single", "multi"], "description": "Default single"},
            "multi_color_style": {"type": "string", "enum": ["striped", "gradient"]},
            "colors": _COLOR_ENTRIES,
        }, ["manufacturer_id", "designation", "material_type", "diameter_mm"]),
        _post(
            "/filaments", "manufacturer_id", "designation", "material_type", "diameter_mm",
            "manufacturer_color_name", "finish_type", "raw_material_weight_g", "default_spool_weight_g",
            "price", "shop_url", "density_g_cm3", "color_mode", "multi_color_style", "colors",
        ),
        write=True,
    ),
    Tool(
        "create_color",
        "Create a colour (name and hex code) that can then be assigned to filaments with set_filament_colors. "
        "Check list_colors first to avoid duplicates.",
        _schema({
            "name": {"type": "string", "minLength": 1},
            "hex_code": {"type": "string", "description": "Hex colour, e.g. #FF0000"},
        }, ["name", "hex_code"]),
        _post("/colors", "name", "hex_code"),
        write=True,
    ),
    Tool(
        "set_filament_colors",
        "Replace the colours of a filament (this is what determines the colour shown for its spools). "
        "Use color_mode single with one colour, or multi with several colours plus multi_color_style.",
        _schema({
            "filament_id": _INT,
            "color_mode": {"type": "string", "enum": ["single", "multi"]},
            "multi_color_style": {"type": "string", "enum": ["striped", "gradient"]},
            "colors": _COLOR_ENTRIES,
        }, ["filament_id", "color_mode", "colors"]),
        _set_filament_colors,
        write=True,
    ),
    Tool(
        "update_filament",
        "Change fields of a filament definition (e.g. price, designation, colour name, temperatures). "
        "Unknown field names are rejected. To change colours use set_filament_colors.",
        _schema({"filament_id": _INT, "fields": {"type": "object"}}, ["filament_id", "fields"]),
        _update_filament,
        write=True,
    ),
)

TOOLS_BY_NAME = {tool.name: tool for tool in TOOLS}


async def _load_flags() -> tuple[bool, bool]:
    async with database.async_session_maker() as db:
        row = (await db.execute(select(AppSettings).where(AppSettings.id == 1))).scalar_one_or_none()
    if row is None:
        return False, False
    return bool(row.mcp_enabled), bool(row.mcp_enabled and row.mcp_write_enabled)


def _rpc_result(req_id: Any, result: dict[str, Any]) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": req_id, "result": result}


def _rpc_error(req_id: Any, code: int, message: str) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": req_id, "error": {"code": code, "message": message}}


def _tool_text(payload: Any, *, is_error: bool = False) -> dict[str, Any]:
    text = payload if isinstance(payload, str) else json.dumps(payload, ensure_ascii=False, default=str)
    if len(text) > MAX_RESULT_CHARS:
        text = text[:MAX_RESULT_CHARS] + "\n…[truncated – use paging or filters for smaller results]"
    text.encode("utf-8")  # Fail inside the tool call so a single result cannot break the response.
    return {"content": [{"type": "text", "text": text}], "isError": is_error}


def _validate_args(tool: Tool, args: dict[str, Any]) -> str | None:
    """Minimal schema check: required keys present, no unknown top-level keys."""
    props = tool.input_schema.get("properties", {})
    missing = [k for k in tool.input_schema.get("required", []) if k not in args]
    if missing:
        return f"Missing required argument(s): {', '.join(missing)}"
    unknown = [k for k in args if k not in props]
    if unknown:
        return f"Unknown argument(s): {', '.join(unknown)}"
    for key in ("spool_id", "filament_id", "printer_id"):
        if key in args and (not isinstance(args[key], int) or isinstance(args[key], bool) or args[key] < 1):
            return f"{key} must be a positive integer"
    for key in ("location_id", "manufacturer_id"):
        if tool.name.startswith("update_") and key in args and (
            not isinstance(args[key], int) or isinstance(args[key], bool) or args[key] < 1
        ):
            return f"{key} must be a positive integer"
    if "fields" in args and not isinstance(args["fields"], dict):
        return "fields must be an object"
    fields_props = props.get("fields", {}).get("properties")
    if fields_props is not None and isinstance(args.get("fields"), dict):
        bad = sorted(k for k in args["fields"] if k not in fields_props)
        if bad:
            return f"Unknown field(s) in fields: {', '.join(bad)}. Allowed: {', '.join(sorted(fields_props))}"
    if tool.name == "update_filament":
        allowed = set(FilamentUpdate.model_fields)
        bad = sorted(k for k in args["fields"] if k not in allowed)
        if bad:
            return (
                f"Unknown field(s) in fields: {', '.join(bad)}. Allowed: {', '.join(sorted(allowed))}. "
                "Colours are set with set_filament_colors."
            )
    return None


async def _call_tool(params: dict[str, Any], request: Request, write_enabled: bool) -> dict[str, Any]:
    name = params.get("name")
    args = params.get("arguments") or {}
    tool = TOOLS_BY_NAME.get(name) if isinstance(name, str) else None
    if tool is None and isinstance(name, str) and "-" in name and isinstance(params.get("arguments", {}), dict):
        try:
            return _tool_text(await call_plugin_read_tool(request, name, args))
        except InvalidPluginToolArguments:
            return _tool_text("Invalid plugin tool arguments", is_error=True)
        except HTTPException as exc:
            return _tool_text({"http_status": exc.status_code, "error": exc.detail}, is_error=True)
        except TimeoutError:
            return _tool_text("Plugin tool timed out", is_error=True)
    if tool is None or not isinstance(args, dict):
        return _tool_text(f"Unknown tool: {name}", is_error=True)
    if tool.write and not write_enabled:
        return _tool_text(
            "Write access via MCP is disabled. An administrator can enable it under "
            "Admin → App Settings → AI assistants (MCP).",
            is_error=True,
        )
    problem = _validate_args(tool, args)
    if problem:
        return _tool_text(problem, is_error=True)

    status_code, body = await tool.handler(args, ApiCaller(request))
    if status_code >= 400:
        detail = body.get("detail", body) if isinstance(body, dict) else body
        return _tool_text({"http_status": status_code, "error": detail}, is_error=True)
    return _tool_text(body if body is not None else {"ok": True})


async def _dispatch(message: Any, request: Request, write_enabled: bool) -> dict[str, Any] | None:
    if not isinstance(message, dict) or message.get("jsonrpc") != "2.0" or "method" not in message:
        return _rpc_error(message.get("id") if isinstance(message, dict) else None, INVALID_REQUEST, "Invalid request")

    method = message["method"]
    req_id = message.get("id")
    params = message.get("params") or {}
    is_notification = "id" not in message

    if is_notification:
        return None  # notifications/initialized, notifications/cancelled, …
    if not isinstance(params, dict):
        return _rpc_error(req_id, INVALID_PARAMS, "params must be an object")

    if method == "initialize":
        requested = params.get("protocolVersion")
        version = requested if requested in SUPPORTED_PROTOCOL_VERSIONS else LATEST_PROTOCOL_VERSION
        return _rpc_result(req_id, {
            "protocolVersion": version,
            "capabilities": {"tools": {"listChanged": False}},
            "serverInfo": {"name": SERVER_NAME, "title": "FilaMan", "version": request.app.version},
            "instructions": INSTRUCTIONS,
        })
    if method == "ping":
        return _rpc_result(req_id, {})
    if method == "tools/list":
        tools = [t.descriptor() for t in TOOLS if write_enabled or not t.write]
        if settings.mcp_plugin_read_tools:
            try:
                async with database.async_session_maker() as db:
                    plugins = await available_plugin_read_tools(request, db)
                tools.extend(descriptor for _, descriptor in plugins.values())
            except Exception:
                logger.exception("MCP plugin tool discovery failed")
        return _rpc_result(req_id, {"tools": tools})
    if method == "tools/call":
        try:
            return _rpc_result(req_id, await _call_tool(params, request, write_enabled))
        except Exception:
            logger.exception("MCP tool call failed: %s", params.get("name"))
            return _rpc_result(req_id, _tool_text("Internal error while running the tool", is_error=True))
    return _rpc_error(req_id, METHOD_NOT_FOUND, f"Method not found: {method}")


def _error(status_code: int, code: str, message: str) -> JSONResponse:
    return JSONResponse(status_code=status_code, content={"detail": {"code": code, "message": message}})


@router.post("/mcp")
async def mcp_endpoint(request: Request) -> Response:
    principal = getattr(request.state, "principal", None)
    if principal is None or principal.auth_type != "api_key":
        return _error(401, "unauthorized", "MCP requires an API key: 'Authorization: ApiKey <key>'")

    enabled, write_enabled = await _load_flags()
    if not enabled:
        return _error(404, "mcp_disabled", "The MCP server is disabled in the app settings")

    try:
        payload = json.loads(await request.body())
    except (ValueError, UnicodeDecodeError):
        return JSONResponse(status_code=400, content=_rpc_error(None, PARSE_ERROR, "Parse error"))

    if isinstance(payload, list):  # JSON-RPC batch (protocol 2025-03-26)
        if not payload:
            return JSONResponse(status_code=400, content=_rpc_error(None, INVALID_REQUEST, "Empty batch"))
        responses = []
        deadline = timeout(MCP_BATCH_TIMEOUT_SECONDS)
        next_index = 0
        try:
            async with deadline:
                for message in payload:
                    response = await _dispatch(message, request, write_enabled)
                    if response is not None:
                        responses.append(response)
                    next_index += 1
                    if deadline.expired():
                        break
        except TimeoutError:
            if not deadline.expired():
                raise
            interrupted_index = next_index
        else:
            interrupted_index = None
        if deadline.expired():
            for pending_index in range(next_index, len(payload)):
                message = payload[pending_index]
                if (
                    isinstance(message, dict)
                    and "id" not in message
                    and message.get("jsonrpc") == "2.0"
                    and "method" in message
                ):
                    continue
                req_id = message.get("id") if isinstance(message, dict) else None
                detail = (
                    "MCP batch deadline exceeded while running this request. Its outcome is unknown."
                    if pending_index == interrupted_index
                    else "MCP batch deadline exceeded before this request started"
                )
                responses.append(_rpc_error(req_id, BATCH_DEADLINE_EXCEEDED, detail))
        return JSONResponse(responses) if responses else Response(status_code=202)

    response = await _dispatch(payload, request, write_enabled)
    if response is None:
        return Response(status_code=202)
    return JSONResponse(response)


@router.get("/mcp")
@router.delete("/mcp")
async def mcp_no_stream() -> Response:
    # Stateless server: no SSE stream and no sessions to terminate.
    return Response(status_code=405, headers={"Allow": "POST"})
