"""Deterministic in-process Spoolman API fixture."""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import httpx

from app.services.spoolman_client import SpoolmanClient


class SpoolmanFixtureServer:
    """Serve a compact Spoolman dataset through an injected HTTP transport."""

    def __init__(self, data: dict[str, Any]):
        self.data = data
        self.requests: list[str] = []

    @classmethod
    def from_path(cls, path: Path) -> SpoolmanFixtureServer:
        return cls(json.loads(path.read_text(encoding="utf-8")))

    def _handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(str(request.url))
        path = request.url.path
        if path in {"/api/v1/info", "/api/v1/health"}:
            return httpx.Response(200, json=self.data["info"])
        if path.startswith("/api/v1/field/"):
            target = path.rsplit("/", 1)[-1]
            return httpx.Response(
                200,
                json=self.data["field_definitions"].get(target, []),
            )
        endpoint = path.rsplit("/", 1)[-1]
        if endpoint not in {"vendor", "filament", "spool", "location"}:
            return httpx.Response(404, json={"message": "not found"})
        rows = self.data[endpoint]
        offset = int(request.url.params.get("offset", 0))
        limit = int(request.url.params.get("limit", 50))
        return httpx.Response(200, json=rows[offset : offset + limit])

    @asynccontextmanager
    async def client_factory(
        self,
        base_url: str,
    ) -> AsyncIterator[SpoolmanClient]:
        async with httpx.AsyncClient(
            transport=httpx.MockTransport(self._handler)
        ) as http:
            yield SpoolmanClient(base_url, client=http)
