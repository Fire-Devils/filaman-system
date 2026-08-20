from pathlib import Path

import httpx
import pytest

from app.services.spoolman_client import SpoolmanClient
from app.services.spoolman_errors import SpoolmanImportError
from tests.support.spoolman_fixture_server import SpoolmanFixtureServer

FIXTURE_PATH = Path(__file__).parent / "fixtures" / "spoolman" / "rich_fields.json"


async def test_fixture_server_supports_pagination_and_field_definitions():
    server = SpoolmanFixtureServer.from_path(FIXTURE_PATH)
    async with server.client_factory("http://spoolman") as client:
        vendors = await client.fetch_all("vendor")
        definitions, warnings, targets = await client.fetch_field_definitions()

    assert vendors == [
        {"id": 1, "name": "Acme Filament", "extra": {"account": '"vendor-a"'}}
    ]
    assert warnings == []
    assert targets == {"vendor", "filament", "spool"}
    assert definitions["spool"][0]["key"] == "tag"


async def test_client_falls_back_from_info_to_health():
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/v1/info":
            return httpx.Response(404)
        if request.url.path == "/api/v1/health":
            return httpx.Response(200, json={"version": "0.25.0"})
        raise AssertionError(request.url)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        client = SpoolmanClient("http://spoolman", client=http)
        assert await client.get_info() == {"version": "0.25.0"}


async def test_client_paginates_until_an_empty_page():
    offsets: list[int] = []

    def handler(request: httpx.Request) -> httpx.Response:
        offset = int(request.url.params["offset"])
        offsets.append(offset)
        rows = [{"id": index} for index in range(offset, min(offset + 50, 55))]
        return httpx.Response(200, json=rows)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        client = SpoolmanClient("http://spoolman", client=http)
        rows = await client.fetch_all("vendor")

    assert len(rows) == 55
    assert offsets == [0, 50, 100]


async def test_client_rejects_a_non_list_collection_response():
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"id": 1})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        client = SpoolmanClient("http://spoolman", client=http)
        with pytest.raises(SpoolmanImportError) as error:
            await client.fetch_all("vendor")

    assert error.value.code == "invalid_response_format"


async def test_client_marks_optional_field_endpoints_unavailable():
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(404, json={"message": "not found"})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        client = SpoolmanClient("http://spoolman", client=http)
        definitions, warnings, targets = await client.fetch_field_definitions()

    assert definitions == {"vendor": [], "filament": [], "spool": []}
    assert len(warnings) == 3
    assert targets == set()
