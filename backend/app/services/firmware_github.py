"""Import ESP firmware images from the GitHub releases of the firmware project."""

import logging
import re
from urllib.parse import urlparse

import httpx
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from app.services import firmware_service as fw

logger = logging.getLogger(__name__)

GITHUB_FIRMWARE_RELEASE_URL = (
    "https://api.github.com/repos/Fire-Devils/FilaMan-System-ESP32/releases/latest"
)
ASSET_RE = re.compile(r"^upgrade_filaman_firmware_(?:esp32s3_)?v[0-9][0-9A-Za-z.+-]*\.bin$")
ALLOWED_HOSTS = {"github.com", "api.github.com"}
TIMEOUT = 15.0
MAX_REDIRECTS = 5


class GithubUnavailableError(Exception):
    """GitHub could not be reached or answered with an unexpected status."""


def _host_allowed(url: str) -> bool:
    parsed = urlparse(url)
    host = (parsed.hostname or "").lower()
    return parsed.scheme == "https" and (
        host in ALLOWED_HOSTS or host.endswith(".githubusercontent.com")
    )


class _AssetError(Exception):
    pass


async def _download(client: httpx.AsyncClient, url: str) -> bytes:
    for _ in range(MAX_REDIRECTS + 1):
        if not _host_allowed(url):
            raise _AssetError("Download-Host nicht erlaubt")
        async with client.stream("GET", url, follow_redirects=False) as response:
            if response.is_redirect:
                location = response.headers.get("location")
                if not location:
                    raise _AssetError("Weiterleitung ohne Ziel")
                url = str(response.url.join(location))
                continue
            if response.status_code != 200:
                raise _AssetError(f"Download fehlgeschlagen (HTTP {response.status_code})")
            data = bytearray()
            async for chunk in response.aiter_bytes():
                data.extend(chunk)
                if len(data) > fw.MAX_FIRMWARE_BYTES:
                    raise _AssetError("Image größer als 2 MB")
            return bytes(data)
    raise _AssetError("Zu viele Weiterleitungen")


def _detail(exc: HTTPException) -> str:
    detail = exc.detail
    return str(detail.get("message")) if isinstance(detail, dict) else str(detail)


def _asset_project_version(name: str) -> tuple[str, str] | None:
    """Map an asset name to (project, version); None if it is not a firmware image."""
    if not ASSET_RE.match(name):
        return None
    project = "filaman-scale-esp32s3" if "_esp32s3_v" in name else "filaman-scale-esp32"
    return project, name.rsplit("_v", 1)[1][: -len(".bin")]


async def fetch_latest_release_info() -> dict:
    """Read the latest release (tag + versions per project) without downloading anything.

    Raises GithubUnavailableError when GitHub cannot be reached.
    """
    from app.services.plugin_service import version_key

    try:
        async with httpx.AsyncClient(timeout=TIMEOUT) as client:
            response = await client.get(
                GITHUB_FIRMWARE_RELEASE_URL, headers={"Accept": "application/vnd.github+json"}
            )
            if response.status_code != 200:
                raise GithubUnavailableError(f"GitHub antwortete mit HTTP {response.status_code}")
            release = response.json()
    except (httpx.HTTPError, ValueError) as exc:
        raise GithubUnavailableError(f"GitHub nicht erreichbar ({type(exc).__name__})") from exc
    projects: dict[str, str] = {}
    for asset in release.get("assets") or []:
        parsed = _asset_project_version(str(asset.get("name", "")))
        if parsed is None:
            continue
        project, version = parsed
        if project not in projects or version_key(version) > version_key(projects[project]):
            projects[project] = version
    return {"tag": str(release.get("tag_name", "")), "projects": projects}


async def import_latest_release(db: AsyncSession) -> dict:
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT) as client:
            response = await client.get(
                GITHUB_FIRMWARE_RELEASE_URL, headers={"Accept": "application/vnd.github+json"}
            )
            if response.status_code != 200:
                raise GithubUnavailableError(f"GitHub antwortete mit HTTP {response.status_code}")
            release = response.json()
            tag = str(release.get("tag_name", ""))
            results: list[dict] = []
            for asset in release.get("assets") or []:
                name = str(asset.get("name", ""))
                if not ASSET_RE.match(name):
                    continue
                item = {"asset": name, "status": "failed", "project": None, "version": None, "message": ""}
                results.append(item)
                if int(asset.get("size") or 0) > fw.MAX_FIRMWARE_BYTES:
                    item.update(status="skipped", message="Image größer als 2 MB, übersprungen")
                    continue
                try:
                    data = await _download(client, str(asset.get("browser_download_url", "")))
                except _AssetError as exc:
                    item["message"] = str(exc)
                    continue
                except httpx.HTTPError as exc:
                    item["message"] = f"Download fehlgeschlagen ({type(exc).__name__})"
                    continue
                try:
                    info = fw.parse_firmware(data)
                except HTTPException as exc:
                    if exc.status_code == 400 and "marker" in _detail(exc):
                        item.update(status="skipped", message="Image ohne OTA-Kennung, Version zu alt")
                    else:
                        item["message"] = _detail(exc)
                    continue
                item.update(project=info.project, version=info.version)
                try:
                    _, state = await fw.import_firmware(db, data)
                except HTTPException as exc:
                    item["message"] = _detail(exc)
                    continue
                item.update(status=state, message="")
            await fw.prune_firmware(db)
            return {"release": tag, "results": results}
    except (httpx.HTTPError, ValueError) as exc:
        raise GithubUnavailableError(f"GitHub nicht erreichbar ({type(exc).__name__})") from exc


async def run_firmware_auto_import_once() -> dict | None:
    """One auto-import pass; does nothing unless ``firmware_auto_import`` is on."""
    from sqlalchemy import select

    from app.core.database import async_session_maker
    from app.models import AppSettings

    async with async_session_maker() as db:
        row = (await db.execute(select(AppSettings).where(AppSettings.id == 1))).scalar_one_or_none()
        if row is None or not row.firmware_auto_import:
            return None
        return await import_latest_release(db)
