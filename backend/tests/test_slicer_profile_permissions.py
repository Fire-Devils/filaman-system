"""Slicer-profile writes need the update permission, not just a login."""

import pytest

from tests.test_rbac import viewer_auth_client, viewer_user  # noqa: F401

WRITES = [
    ("post", "/api/v1/spools/1/slicer-profile/default", {"base_name": "Generic PLA"}),
    ("put", "/api/v1/spools/1/slicer-profile/default", {"base_name": "Generic PLA"}),
    ("post", "/api/v1/spools/1/slicer-profile/models/X1C", {"base_name": "Generic PLA"}),
    ("put", "/api/v1/spools/1/slicer-profile/models/X1C", {"clear_override": True}),
    ("post", "/api/v1/spools/1/slicer-profile/backfill-to-filament", {}),
    ("post", "/api/v1/filaments/1/slicer-profile/default", {"base_name": "Generic PLA"}),
    ("put", "/api/v1/filaments/1/slicer-profile/default", {"base_name": "Generic PLA"}),
    ("post", "/api/v1/filaments/1/slicer-profile/models/X1C", {"base_name": "Generic PLA"}),
    ("put", "/api/v1/filaments/1/slicer-profile/models/X1C", {"clear_override": True}),
]


@pytest.mark.asyncio
@pytest.mark.parametrize("method,path,body", WRITES)
async def test_viewer_cannot_write_slicer_profiles(viewer_auth_client, method, path, body):  # noqa: F811
    client, csrf = viewer_auth_client
    response = await getattr(client, method)(path, json=body, headers={"X-CSRF-Token": csrf})
    assert response.status_code == 403
    assert response.json()["detail"]["code"] == "forbidden"
