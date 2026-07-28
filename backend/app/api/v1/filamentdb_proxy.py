"""Proxy endpoints for the FilaMan FilamentDB community database.

Provides search/lookup endpoints that proxy requests to db.filaman.app,
and a prepare-filament endpoint that auto-creates missing manufacturers
and colors locally before returning pre-filled data for the create form.
"""

import asyncio
import logging
from typing import Any

import httpx
from fastapi import APIRouter, HTTPException, Query, status
from fastapi.responses import Response
from pydantic import BaseModel
from sqlalchemy import func, select

from app.api.deps import DBSession, PrincipalDep
from app.core.config import settings, MANUFACTURER_LOGO_DIR
from app.models import Color, FilamentColor, Manufacturer
from app.models.plugin import InstalledPlugin
from app.utils.search import (
    FUZZY_MATCH_THRESHOLD,
    fuzzy_token_score,
    search_probe_terms,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/filamentdb", tags=["FilamentDB Proxy"])

_TIMEOUT = 15.0  # seconds
_BASE_URL = property(lambda _: settings.filamentdb_url.rstrip("/"))
_FUZZY_FALLBACK_TIMEOUT = 8.0
_FUZZY_PROBE_PAGE_SIZE = 50
_LOOKUP_TEXT_MAX_DEPTH = 4
_LOOKUP_TEXT_MAX_VALUES = 32
_FILAMENT_LOOKUP_TEXT_KEYS = {
    "color_name",
    "designation",
    "material_key",
    "material_name",
    "material_subtype",
}
_SPOOL_PROFILE_LOOKUP_TEXT_KEYS = {
    "manufacturer_name",
    "name",
    "spool_material",
}


@router.get("/status")
async def filamentdb_status(db: DBSession, _principal: PrincipalDep):
    """Check if the FilamentDB plugin is active."""
    result = await db.execute(
        select(InstalledPlugin).where(
            InstalledPlugin.plugin_key == "filamentdb_import",
        )
    )
    plugin = result.scalar_one_or_none()
    return {"active": plugin is not None and plugin.is_active}


def _api_url(path: str) -> str:
    return f"{settings.filamentdb_url.rstrip('/')}/api/v1{path}"


async def _proxy_get(
    path: str,
    params: dict[str, Any] | None = None,
    *,
    client: httpx.AsyncClient | None = None,
) -> Any:
    """Forward a GET request to the FilamentDB API."""
    url = _api_url(path)

    async def fetch(active_client: httpx.AsyncClient) -> Any:
        resp = await active_client.get(url, params=params)
        resp.raise_for_status()
        return resp.json()

    try:
        if client is not None:
            return await fetch(client)
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            return await fetch(client)
    except httpx.TimeoutException:
        raise HTTPException(
            status_code=status.HTTP_504_GATEWAY_TIMEOUT,
            detail={
                "code": "filamentdb_timeout",
                "message": "FilamentDB is not responding",
            },
        )
    except httpx.HTTPStatusError as exc:
        raise HTTPException(
            status_code=exc.response.status_code,
            detail={
                "code": "filamentdb_error",
                "message": f"FilamentDB returned {exc.response.status_code}",
            },
        )
    except httpx.HTTPError:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail={
                "code": "filamentdb_unreachable",
                "message": "Cannot reach FilamentDB",
            },
        )


def _response_items(data: Any) -> list[dict[str, Any]]:
    if not isinstance(data, dict):
        return []
    items = data.get("items")
    if not isinstance(items, list):
        return []
    return [item for item in items if isinstance(item, dict)]


def _item_key(
    item: dict[str, Any],
    fallback_index: int,
    text_keys: set[str],
) -> tuple[str, Any]:
    item_id = item.get("id")
    if item_id is not None:
        return ("id", item_id)
    return ("text", _lookup_text(item, text_keys) or fallback_index)


def _lookup_text(item: dict[str, Any], text_keys: set[str]) -> str:
    values: list[str] = []

    def collect(value: Any, key: str | None = None, depth: int = 0) -> None:
        if depth > _LOOKUP_TEXT_MAX_DEPTH or len(values) >= _LOOKUP_TEXT_MAX_VALUES:
            return
        if isinstance(value, dict):
            for child_key, child_value in value.items():
                collect(child_value, child_key, depth + 1)
        elif isinstance(value, list):
            for child_value in value:
                collect(child_value, key, depth + 1)
        elif isinstance(value, str) and key in text_keys:
            values.append(value)

    collect(item)
    return " ".join(values)


async def _search_with_fuzzy_fallback(
    path: str,
    params: dict[str, Any],
    *,
    search: str | None,
    page: int,
    page_size: int,
    text_keys: set[str],
) -> Any:
    direct_data = await _proxy_get(path, params)
    if not search or _response_items(direct_data):
        return direct_data

    probe_terms = search_probe_terms(search)
    if not probe_terms:
        return direct_data

    base_params = {
        key: value
        for key, value in params.items()
        if key not in {"search", "page", "page_size"}
    }
    probe_page_size = min(max(page_size, _FUZZY_PROBE_PAGE_SIZE), 100)
    candidates: dict[tuple[str, Any], dict[str, Any]] = {}

    probe_params_list = [
        {
            **base_params,
            "search": term,
            "page": 1,
            "page_size": probe_page_size,
        }
        for term in probe_terms
    ]

    async def fetch_probe(
        client: httpx.AsyncClient,
        probe_params: dict[str, Any],
    ) -> Any | None:
        try:
            return await _proxy_get(path, probe_params, client=client)
        except HTTPException:
            return None

    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            probe_data_list = await asyncio.wait_for(
                asyncio.gather(
                    *(fetch_probe(client, probe_params) for probe_params in probe_params_list)
                ),
                timeout=_FUZZY_FALLBACK_TIMEOUT,
            )
    except TimeoutError:
        return direct_data

    for probe_data in probe_data_list:
        for index, item in enumerate(_response_items(probe_data)):
            candidates.setdefault(_item_key(item, index, text_keys), item)

    scored: list[tuple[float, str, dict[str, Any]]] = []
    for item in candidates.values():
        text = _lookup_text(item, text_keys)
        score = fuzzy_token_score(search, text)
        if score >= FUZZY_MATCH_THRESHOLD:
            label = item.get("designation") or item.get("name") or ""
            scored.append((score, str(label).lower(), item))

    scored.sort(key=lambda entry: (-entry[0], entry[1]))

    start = (page - 1) * page_size
    paged_items = [item for _, _, item in scored[start : start + page_size]]
    if not paged_items:
        return direct_data

    response = dict(direct_data) if isinstance(direct_data, dict) else {}
    response.update(
        {
            "items": paged_items,
            "total": len(scored),
            "page": page,
            "page_size": page_size,
        }
    )
    return response


# ── Search endpoints ───────────────────────────────────────────────


@router.get("/manufacturers")
async def search_manufacturers(
    _principal: PrincipalDep,
    search: str | None = Query(None, min_length=1),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
):
    """Search manufacturers in the FilamentDB community database."""
    params: dict[str, Any] = {"page": page, "page_size": page_size}
    if search:
        params["search"] = search
    return await _proxy_get("/manufacturers", params)


@router.get("/filaments")
async def search_filaments(
    _principal: PrincipalDep,
    search: str | None = Query(None, min_length=1),
    manufacturer_id: int | None = Query(None),
    manufacturer_name: str | None = Query(
        None,
        min_length=2,
        description="Resolve manufacturer name to FilamentDB ID, then filter filaments.",
    ),
    material_key: str | None = Query(None),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
):
    """Search filaments in the FilamentDB community database.

    When *manufacturer_name* is provided (and manufacturer_id is not),
    we first search the FilamentDB manufacturers by name, pick the best
    match, and use its ID to filter filaments.
    """
    # Resolve manufacturer_name → manufacturer_id in FilamentDB
    if manufacturer_name and manufacturer_id is None:
        mfr_data = await _proxy_get(
            "/manufacturers",
            {"search": manufacturer_name, "page_size": 5},
        )
        mfr_items = mfr_data.get("items", [])
        # Prefer exact match (case-insensitive), fall back to first result
        resolved_id = None
        for m in mfr_items:
            if m.get("name", "").lower() == manufacturer_name.lower():
                resolved_id = m["id"]
                break
        if resolved_id is None and mfr_items:
            resolved_id = mfr_items[0]["id"]
        if resolved_id is None:
            # No manufacturer found → return empty result
            return {"items": [], "total": 0, "page": page, "page_size": page_size}
        manufacturer_id = resolved_id

    params: dict[str, Any] = {"page": page, "page_size": page_size}
    if search:
        params["search"] = search
    if manufacturer_id is not None:
        params["manufacturer_id"] = manufacturer_id
    if material_key:
        params["material_key"] = material_key
    return await _search_with_fuzzy_fallback(
        "/filaments",
        params,
        search=search,
        page=page,
        page_size=page_size,
        text_keys=_FILAMENT_LOOKUP_TEXT_KEYS,
    )


@router.get("/spool-profiles")
async def search_spool_profiles(
    _principal: PrincipalDep,
    search: str | None = Query(None, min_length=1),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
):
    """Search spool profiles in the FilamentDB community database."""
    params: dict[str, Any] = {"page": page, "page_size": page_size}
    if search:
        params["search"] = search
    return await _search_with_fuzzy_fallback(
        "/spool-profiles",
        params,
        search=search,
        page=page,
        page_size=page_size,
        text_keys=_SPOOL_PROFILE_LOOKUP_TEXT_KEYS,
    )


@router.get("/spool-profile-image")
async def proxy_spool_profile_image(
    _principal: PrincipalDep,
    image_file: str = Query(..., min_length=1, max_length=500),
):
    """Proxy a spool profile image from the FilamentDB server.

    Returns the image bytes with appropriate content-type and cache headers.
    """
    # Sanitise: only allow simple filenames (no path traversal)
    if "/" in image_file or "\\" in image_file or ".." in image_file:
        raise HTTPException(status_code=400, detail="Invalid image_file")

    image_url = (
        f"{settings.filamentdb_url.rstrip('/')}/uploads/spool-profiles/{image_file}"
    )
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            resp = await client.get(image_url)
            resp.raise_for_status()
    except (httpx.HTTPStatusError, httpx.HTTPError):
        raise HTTPException(status_code=404, detail="Image not found")

    content_type = resp.headers.get("content-type", "image/png")
    return Response(
        content=resp.content,
        media_type=content_type,
        headers={"Cache-Control": "public, max-age=86400"},
    )


# ── Prepare endpoint (creates missing entities locally) ─────────────


class PrepareFilamentRequest(BaseModel):
    """Data from a FilamentDB filament record to prepare locally."""

    # Manufacturer info
    manufacturer_name: str
    manufacturer_website: str | None = None
    manufacturer_slug: str | None = None
    manufacturer_has_web_logo: bool = False
    manufacturer_has_label_logo: bool = False

    # Filament info (for form pre-fill only, not persisted here)
    designation: str
    material_key: str | None = None
    material_name: str | None = None
    material_subtype: str | None = None
    diameter_mm: float = 1.75
    density_g_cm3: float | None = None
    nominal_weight_g: int | None = None
    price: float | None = None
    currency: str | None = None
    shop_url: str | None = None
    color_mode: str = "single"
    multi_color_style: str | None = None

    # Colors from FilamentDB
    colors: list[dict[str, Any]] = []
    # e.g. [{"hex_code": "#FF0000", "color_name": "Red", "position": 1}]

    # Spool profile info (for spool defaults)
    spool_profile_empty_weight_g: float | None = None
    spool_profile_outer_diameter_mm: float | None = None
    spool_profile_width_mm: float | None = None
    spool_profile_material: str | None = None


class PrepareFilamentResponse(BaseModel):
    """Result of prepare-filament: local IDs + pre-filled form data."""

    manufacturer_id: int
    manufacturer_created: bool
    color_ids: list[int]
    colors_created: int
    prefilled: dict[str, Any]


@router.post("/prepare-filament", response_model=PrepareFilamentResponse)
async def prepare_filament(
    data: PrepareFilamentRequest,
    db: DBSession,
    _principal: PrincipalDep,
):
    """Prepare a filament import from FilamentDB.

    1. Find or create the manufacturer locally (name match, case-insensitive).
    2. Find or create each color locally (hex_code match).
    3. Return local IDs + pre-filled form data.
    """
    # ── 1. Manufacturer ─────────────────────────────────────────────
    manufacturer_created = False
    stmt = select(Manufacturer).where(
        func.lower(Manufacturer.name) == data.manufacturer_name.lower()
    )
    result = await db.execute(stmt)
    manufacturer = result.scalar_one_or_none()

    if manufacturer is None:
        manufacturer = Manufacturer(
            name=data.manufacturer_name,
            url=data.manufacturer_website,
            empty_spool_weight_g=data.spool_profile_empty_weight_g,
            spool_outer_diameter_mm=data.spool_profile_outer_diameter_mm,
            spool_width_mm=data.spool_profile_width_mm,
            spool_material=data.spool_profile_material,
        )
        db.add(manufacturer)
        await db.flush()
        manufacturer_created = True
        logger.info(
            "Auto-created manufacturer '%s' (id=%s)", manufacturer.name, manufacturer.id
        )

        # Download brand logo from FilamentDB (non-blocking: log errors, don't fail)
        if data.manufacturer_has_web_logo and data.manufacturer_slug:
            MANUFACTURER_LOGO_DIR.mkdir(parents=True, exist_ok=True)
            base_url = settings.filamentdb_url.rstrip("/")
            try:
                async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
                    # Web logo
                    logo_url = (
                        f"{base_url}/uploads/logos/web/{data.manufacturer_slug}.png"
                    )
                    resp = await client.get(logo_url)
                    resp.raise_for_status()
                logo_path = MANUFACTURER_LOGO_DIR / f"{manufacturer.id}.png"
                logo_path.write_bytes(resp.content)
                manufacturer.logo_file = f"{manufacturer.id}.png"
                logger.info(
                    "Downloaded logo for auto-created manufacturer '%s' (id=%s, slug=%s)",
                    manufacturer.name,
                    manufacturer.id,
                    data.manufacturer_slug,
                )
            except (httpx.HTTPError, OSError) as exc:
                logger.warning(
                    "Could not download logo for manufacturer '%s' (slug=%s): %s",
                    manufacturer.name,
                    data.manufacturer_slug,
                    exc,
                )

            # Label logo (grayscale, for label printing) — non-critical
            if data.manufacturer_has_label_logo:
                try:
                    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
                        label_url = f"{base_url}/uploads/logos/label/{data.manufacturer_slug}.png"
                        label_resp = await client.get(label_url)
                        label_resp.raise_for_status()
                    label_path = MANUFACTURER_LOGO_DIR / f"{manufacturer.id}_label.png"
                    label_path.write_bytes(label_resp.content)
                    manufacturer.label_logo_file = f"{manufacturer.id}_label.png"
                    logger.info(
                        "Downloaded label logo for auto-created manufacturer '%s' (id=%s, slug=%s)",
                        manufacturer.name,
                        manufacturer.id,
                        data.manufacturer_slug,
                    )
                except (httpx.HTTPError, OSError) as exc:
                    logger.warning(
                        "Could not download label logo for manufacturer '%s' (slug=%s): %s",
                        manufacturer.name,
                        data.manufacturer_slug,
                        exc,
                    )

    # ── 2. Colors ────────────────────────────────────────────────────
    color_ids: list[int] = []
    colors_created = 0

    for color_entry in data.colors:
        hex_code = color_entry.get("hex_code", "").upper().strip()
        color_name = color_entry.get("color_name", "")
        if not hex_code:
            continue

        # Normalize hex code
        if not hex_code.startswith("#"):
            hex_code = f"#{hex_code}"

        # Search by hex code (case-insensitive)
        stmt = select(Color).where(func.upper(Color.hex_code) == hex_code.upper())
        result = await db.execute(stmt)
        color = result.scalar_one_or_none()

        if color is None:
            # Create new color
            color = Color(
                name=color_name or hex_code,
                hex_code=hex_code,
            )
            db.add(color)
            await db.flush()
            colors_created += 1
            logger.info(
                "Auto-created color '%s' %s (id=%s)", color.name, hex_code, color.id
            )

        color_ids.append(color.id)

    await db.commit()

    # ── 3. Build pre-filled data ─────────────────────────────────────
    prefilled = {
        "manufacturer_id": manufacturer.id,
        "designation": data.designation,
        "material_type": (data.material_name or data.material_key or "").upper(),
        "diameter_mm": data.diameter_mm,
        "density_g_cm3": data.density_g_cm3,
        "raw_material_weight_g": data.nominal_weight_g,
        "price": data.price,
        "shop_url": data.shop_url,
        "color_mode": data.color_mode,
        "multi_color_style": data.multi_color_style,
        "material_subgroup": data.material_subtype,
        "default_spool_weight_g": data.spool_profile_empty_weight_g,
        "spool_outer_diameter_mm": data.spool_profile_outer_diameter_mm,
        "spool_width_mm": data.spool_profile_width_mm,
        "spool_material": data.spool_profile_material,
        "color_ids": color_ids,
    }

    return PrepareFilamentResponse(
        manufacturer_id=manufacturer.id,
        manufacturer_created=manufacturer_created,
        color_ids=color_ids,
        colors_created=colors_created,
        prefilled=prefilled,
    )
