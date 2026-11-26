"""HTTP-Client für die schreibenden Endpunkte der FilaMan-DB (Token-Auth).

Die Fehler der DB (``{"detail": {"code", "message", ...}}``) werden in
``FilamentDBError`` übersetzt; ``to_http`` macht daraus eine saubere
FilaMan-Antwort. Wichtig: ein ungültiger Token wird bewusst NICHT als 401
weitergereicht, weil das Frontend 401 als „abgemeldet“ behandelt.
"""

import logging
from typing import Any

import httpx
from fastapi import HTTPException

from app.core.config import settings

logger = logging.getLogger(__name__)

TIMEOUT = 15.0
# Tests setzen hier einen httpx.MockTransport.
_TRANSPORT: httpx.AsyncBaseTransport | None = None


class FilamentDBError(Exception):
    def __init__(
        self,
        status_code: int,
        code: str,
        message: str,
        extra: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message
        self.extra = extra or {}

    def to_http(self) -> HTTPException:
        status_code = self.status_code
        code = self.code
        if status_code == 401 or code == "invalid_token":
            status_code, code = 400, "filamentdb_token_invalid"
        elif status_code == 403 and code == "insufficient_scope":
            code = "filamentdb_insufficient_scope"
        detail: dict[str, Any] = {"code": code, "message": self.message}
        detail.update(self.extra)
        return HTTPException(status_code=status_code, detail=detail)


def api_url(path: str) -> str:
    return f"{settings.filamentdb_url.rstrip('/')}/api/v1{path}"


async def fdb_request(
    method: str,
    path: str,
    *,
    token: str | None = None,
    json: Any = None,
    params: dict[str, Any] | None = None,
) -> Any:
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT, transport=_TRANSPORT) as client:
            resp = await client.request(
                method, api_url(path), headers=headers, json=json, params=params
            )
    except httpx.TimeoutException as exc:
        raise FilamentDBError(504, "filamentdb_timeout", "FilamentDB is not responding") from exc
    except httpx.HTTPError as exc:
        raise FilamentDBError(502, "filamentdb_unreachable", "Cannot reach FilamentDB") from exc

    if resp.status_code >= 400:
        raise _error_from_response(resp)
    if resp.status_code == 204 or not resp.content:
        return None
    try:
        return resp.json()
    except ValueError as exc:
        raise FilamentDBError(502, "filamentdb_error", "FilamentDB returned invalid JSON") from exc


def _error_from_response(resp: httpx.Response) -> FilamentDBError:
    code = "filamentdb_error"
    message = f"FilamentDB returned {resp.status_code}"
    extra: dict[str, Any] = {}
    try:
        detail = resp.json().get("detail")
    except (ValueError, AttributeError):
        detail = None
    if isinstance(detail, dict):
        code = str(detail.get("code") or code)
        message = str(detail.get("message") or message)
        extra = {k: v for k, v in detail.items() if k not in ("code", "message")}
    elif isinstance(detail, str):
        message = detail
    elif isinstance(detail, list) and detail:
        # FastAPI-Validierungsfehler der DB.
        first = detail[0] if isinstance(detail[0], dict) else {}
        loc = first.get("loc")
        if isinstance(loc, list) and loc:
            extra["field"] = str(loc[-1])
        message = str(first.get("msg") or message)
        code = "validation_error"
    return FilamentDBError(resp.status_code, code, message, extra)
