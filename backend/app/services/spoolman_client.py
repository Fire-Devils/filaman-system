"""Injectable HTTP client for Spoolman source APIs."""

from __future__ import annotations

from typing import Any, Self

import httpx

from app.services.spoolman_errors import SpoolmanImportError


class SpoolmanClient:
    def __init__(
        self,
        base_url: str,
        *,
        client: httpx.AsyncClient | None = None,
    ):
        self.base_url = base_url.rstrip("/")
        self._client = client
        self._owns_client = client is None

    async def __aenter__(self) -> Self:
        if self._client is None:
            self._client = httpx.AsyncClient(timeout=60.0)
        return self

    async def __aexit__(self, *_exc: object) -> None:
        if self._owns_client and self._client is not None:
            await self._client.aclose()

    @property
    def http(self) -> httpx.AsyncClient:
        if self._client is None:
            raise RuntimeError("SpoolmanClient must be entered before use")
        return self._client

    async def get_info(self) -> dict[str, Any]:
        for endpoint in ("info", "health"):
            try:
                response = await self.http.get(
                    f"{self.base_url}/api/v1/{endpoint}",
                    timeout=10.0,
                )
            except httpx.TimeoutException as exc:
                raise SpoolmanImportError(
                    f"Timeout connecting to '{self.base_url}'",
                    "connection_timeout",
                ) from exc
            except httpx.RequestError as exc:
                raise SpoolmanImportError(
                    f"Could not connect to '{self.base_url}': {exc}",
                    "connection_failed",
                ) from exc
            if endpoint == "info" and response.status_code == 404:
                continue
            if response.status_code != 200:
                raise SpoolmanImportError(
                    f"Spoolman returned status {response.status_code}",
                    "connection_failed",
                )
            try:
                payload = response.json()
            except ValueError as exc:
                raise SpoolmanImportError(
                    "Spoolman returned invalid JSON",
                    "invalid_response",
                ) from exc
            if not isinstance(payload, dict):
                raise SpoolmanImportError(
                    "Spoolman info response must be an object",
                    "invalid_response",
                )
            return payload
        raise SpoolmanImportError(
            "Spoolman info and health endpoints are unavailable",
            "connection_failed",
        )

    async def fetch_all(
        self,
        endpoint: str,
        extra_params: dict[str, Any] | None = None,
    ) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []
        offset = 0
        limit = 50
        while True:
            params: dict[str, Any] = {"limit": limit, "offset": offset}
            if extra_params:
                params.update(extra_params)
            try:
                response = await self.http.get(
                    f"{self.base_url}/api/v1/{endpoint}",
                    params=params,
                )
            except httpx.TimeoutException as exc:
                raise SpoolmanImportError(
                    f"Timeout fetching /{endpoint} at offset {offset}",
                    "fetch_timeout",
                ) from exc
            except httpx.RequestError as exc:
                raise SpoolmanImportError(
                    f"Network error fetching /{endpoint}: {exc}",
                    "fetch_network_error",
                ) from exc
            if response.status_code != 200:
                raise SpoolmanImportError(
                    f"Could not fetch /{endpoint}: status {response.status_code}",
                    "fetch_error",
                )
            try:
                batch = response.json()
            except ValueError as exc:
                raise SpoolmanImportError(
                    f"Invalid JSON from /{endpoint}",
                    "invalid_json",
                ) from exc
            if not isinstance(batch, list) or not all(
                isinstance(item, dict) for item in batch
            ):
                raise SpoolmanImportError(
                    f"Unexpected response from /{endpoint}: list of objects required",
                    "invalid_response_format",
                )
            if not batch:
                break
            rows.extend(batch)
            offset += limit
        return rows

    async def fetch_field_definitions(
        self,
    ) -> tuple[dict[str, list[dict[str, Any]]], list[str], set[str]]:
        definitions: dict[str, list[dict[str, Any]]] = {}
        warnings: list[str] = []
        available_targets: set[str] = set()
        for target in ("vendor", "filament", "spool"):
            try:
                response = await self.http.get(
                    f"{self.base_url}/api/v1/field/{target}"
                )
                if response.status_code in {404, 405, 422}:
                    definitions[target] = []
                    warnings.append(
                        f"Spoolman field definitions for {target} are unavailable."
                    )
                    continue
                response.raise_for_status()
                payload = response.json()
                if not isinstance(payload, list) or not all(
                    isinstance(item, dict) for item in payload
                ):
                    raise ValueError("expected a list of field definitions")
            except (httpx.HTTPError, ValueError) as exc:
                definitions[target] = []
                warnings.append(
                    f"Could not load Spoolman field definitions for {target}: {exc}"
                )
                continue
            definitions[target] = payload
            available_targets.add(target)
        return definitions, warnings, available_targets
