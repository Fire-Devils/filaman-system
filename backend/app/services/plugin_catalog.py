"""Fetch the maintainer catalog and verify release archives."""

from hashlib import sha256
from typing import Annotated, Self

import httpx
from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, model_validator

from app.services.plugin_service import MAX_ZIP_SIZE, PluginInstallError

CATALOG_URL = "https://raw.githubusercontent.com/Fire-Devils/filaman-system/main/plugin-catalog/catalog-v1.json"
PLUGIN_DOWNLOAD_ROOT = "https://www.filaman.app/plugins/"
MAX_CATALOG_SIZE = 256 * 1024

PluginKey = Annotated[str, Field(pattern=r"^[a-z][a-z0-9_]{2,49}$")]
ReleaseVersion = Annotated[str, Field(pattern=r"^[0-9]{1,9}\.[0-9]{1,9}\.[0-9]{1,9}$")]
ReleaseDigest = Annotated[str, Field(pattern=r"^[a-f0-9]{64}$")]


class CatalogRelease(BaseModel):
    model_config = ConfigDict(extra="forbid")

    plugin_key: PluginKey
    name: str = Field(min_length=1, max_length=100)
    description: str = Field(min_length=1, max_length=500)
    publisher: str = Field(min_length=1, max_length=100)
    repository_url: str = Field(pattern=r"^https://github\.com/[\w.-]+/[\w.-]+$", max_length=250)
    version: ReleaseVersion
    min_filaman_version: ReleaseVersion
    zip_path: str | None = Field(default=None, max_length=100)
    github_release_url: str | None = Field(
        default=None,
        max_length=1024,
        pattern=(
            r"^https://github\.com/[\w.-]+/[\w.-]+/releases/download/"
            r"(?:[A-Za-z0-9_.~+@-]|%[0-9A-Fa-f]{2})+/(?:[A-Za-z0-9_.~+@-]|%[0-9A-Fa-f]{2})+\.zip$"
        ),
    )
    sha256: ReleaseDigest

    @model_validator(mode="after")
    def validate_zip_source(self) -> Self:
        if (self.zip_path is None) == (self.github_release_url is None):
            raise ValueError("Specify exactly one ZIP source")
        if self.github_release_url and not self.github_release_url.lower().startswith(
            f"{self.repository_url.lower()}/releases/download/"
        ):
            raise ValueError("GitHub ZIP must be attached to a release in the listed repository")
        filename = f"{self.plugin_key}-{self.version}.zip"
        if self.zip_path is not None and self.zip_path not in (filename, f"catalog/{filename}"):
            raise ValueError("ZIP path must match the plugin key and version")
        return self

    @property
    def release_id(self) -> str:
        return sha256(self.model_dump_json(exclude_none=True).encode()).hexdigest()

    @property
    def download_url(self) -> str:
        return self.github_release_url or f"{PLUGIN_DOWNLOAD_ROOT}{self.zip_path}"


class CatalogSelection(BaseModel):
    model_config = ConfigDict(extra="forbid")

    plugin_key: PluginKey
    version: ReleaseVersion
    release_id: ReleaseDigest


_CATALOG = TypeAdapter(list[CatalogRelease])


def parse_catalog(data: bytes) -> dict[str, CatalogRelease]:
    if len(data) > MAX_CATALOG_SIZE:
        raise ValueError("Catalog exceeds size limit")
    entries = _CATALOG.validate_json(data)
    releases = {entry.plugin_key: entry for entry in entries}
    if len(releases) != len(entries):
        raise ValueError("Duplicate plugin key")
    return releases


async def _download(url: str, limit: int, *, allow_github_redirect: bool = False) -> bytes:
    async with httpx.AsyncClient(timeout=10.0, follow_redirects=False) as client:
        while True:
            async with client.stream("GET", url) as response:
                if allow_github_redirect and response.next_request is not None:
                    target = response.next_request.url
                    if (
                        target.scheme != "https"
                        or target.netloc != b"release-assets.githubusercontent.com"
                        or target.userinfo
                    ):
                        raise ValueError("Unexpected GitHub release download host")
                    url = str(target)
                    allow_github_redirect = False
                    continue
                response.raise_for_status()
                data = bytearray()
                async for chunk in response.aiter_bytes():
                    if len(data) + len(chunk) > limit:
                        raise ValueError("Download exceeds size limit")
                    data.extend(chunk)
                return bytes(data)


async def fetch_catalog() -> dict[str, CatalogRelease]:
    return parse_catalog(await _download(CATALOG_URL, MAX_CATALOG_SIZE))


async def fetch_verified_zip(release: CatalogRelease) -> bytes:
    try:
        data = await _download(
            release.download_url, MAX_ZIP_SIZE, allow_github_redirect=release.github_release_url is not None
        )
    except (httpx.HTTPError, ValueError) as exc:
        raise PluginInstallError("Could not download the plugin ZIP.", "download_failed") from exc
    if sha256(data).hexdigest() != release.sha256:
        raise PluginInstallError("Plugin ZIP checksum does not match the catalog.", "checksum_mismatch")
    return data
