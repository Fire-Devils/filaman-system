"""Validate the catalog against the exact public release ZIPs."""

import asyncio
from pathlib import Path

from app.core.seeds import BUILTIN_PLUGINS, DEPRECATED_PLUGINS
from app.services.plugin_catalog import fetch_verified_zip, parse_catalog
from app.services.plugin_service import PluginInstallService


async def check() -> None:
    releases = parse_catalog(Path(__file__).with_name("catalog-v1.json").read_bytes())
    reserved_keys = {plugin["plugin_key"] for plugin in BUILTIN_PLUGINS} | set(DEPRECATED_PLUGINS)
    conflicts = sorted(releases.keys() & reserved_keys)
    if conflicts:
        raise ValueError(f"Catalog cannot list built-in or deprecated plugins: {', '.join(conflicts)}")

    for release in releases.values():
        data = await fetch_verified_zip(release)
        with PluginInstallService.validated_archive(data, (release.plugin_key, release.version)):
            print(f"Verified {release.plugin_key} {release.version}")


if __name__ == "__main__":
    asyncio.run(check())
