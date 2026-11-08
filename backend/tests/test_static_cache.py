import pytest
from app.main import add_cache_control_header
from httpx import ASGITransport, AsyncClient
from starlette.applications import Starlette
from starlette.middleware import Middleware
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.routing import Mount
from starlette.staticfiles import StaticFiles


@pytest.mark.parametrize(
    ("path", "cache_control"),
    [
        ("/spool-reel.js", "no-cache"),
        ("/spool-reel.js?v=2", "no-cache"),
        ("/plugin-fonts.css", "no-cache"),
        ("/plugin-fonts.css?v=2", "no-cache"),
        ("/color-harmonies.js", "no-cache"),
        ("/color-harmonies.css", "no-cache"),
        ("/icons.svg", "no-cache"),
        ("/icons.svg?v=2", "no-cache"),
        ("/_astro/app.a1b2.js", "public, max-age=31536000, immutable"),
        ("/_astro/font.a1b2.woff2", "public, max-age=31536000, immutable"),
    ],
)
async def test_static_asset_cache_policy(tmp_path, path, cache_control):
    asset = tmp_path / path.split("?", 1)[0].lstrip("/")
    asset.parent.mkdir(parents=True, exist_ok=True)
    asset.write_text("asset")
    app = Starlette(
        routes=[Mount("/", app=StaticFiles(directory=tmp_path))],
        middleware=[Middleware(BaseHTTPMiddleware, dispatch=add_cache_control_header)],
    )
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.get(path)
        assert response.status_code == 200
        assert response.headers["cache-control"] == cache_control

        revalidated = await client.get(path, headers={"If-None-Match": response.headers["etag"]})
        assert revalidated.status_code == 304
        assert revalidated.headers["cache-control"] == cache_control


@pytest.mark.parametrize(
    ("status", "media_type", "original", "policy"),
    [
        (200, "text/html", None, "no-cache"),
        (404, "application/json", None, "no-store"),
        (200, "text/javascript", "public, max-age=31536000, immutable", "no-cache"),
        (304, "text/javascript", None, "no-cache"),
        (200, "application/json", "private, no-store", "private, no-store"),
        (200, "application/json", "private, max-age=60", "private, no-cache"),
    ],
)
async def test_plugin_asset_requests_revalidate(status, media_type, original, policy):
    from starlette.responses import Response
    from starlette.routing import Route

    async def asset(request):
        headers = {"Cache-Control": original} if original else None
        return Response(status_code=status, media_type=media_type, headers=headers)

    app = Starlette(
        routes=[Route("/plugins/example/assets/app-hash.js", asset)],
        middleware=[Middleware(BaseHTTPMiddleware, dispatch=add_cache_control_header)],
    )
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.get("/plugins/example/assets/app-hash.js")
        assert response.status_code == status
        assert response.headers["cache-control"] == policy
