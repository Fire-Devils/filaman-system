"""Small opt-in smoke test against any live Spoolman instance."""

import os

import pytest

from app.services.spoolman_import_service import SpoolmanImportService

SPOOLMAN_TEST_URL = os.getenv("SPOOLMAN_TEST_URL", "").rstrip("/")
pytestmark = pytest.mark.skipif(
    not SPOOLMAN_TEST_URL,
    reason="Set SPOOLMAN_TEST_URL to run live Spoolman smoke tests.",
)


async def test_live_spoolman_connection_preview_and_legacy_import(db_session):
    service = SpoolmanImportService(db_session)
    connection = await service.test_connection(SPOOLMAN_TEST_URL)
    preview = await service.preview(SPOOLMAN_TEST_URL)

    assert connection["status"] == "ok"
    assert isinstance(connection["info"], dict)
    assert preview.summary["vendors"] >= 0
    assert preview.summary["filaments"] >= 0
    assert preview.summary["spools"] >= 0

    result = await service.execute(SPOOLMAN_TEST_URL)
    assert isinstance(result.errors, list)
    assert result.filaments_created + result.filaments_skipped >= 0
    assert result.spools_created + result.spools_skipped >= 0
