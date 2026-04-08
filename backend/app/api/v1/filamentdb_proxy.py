"""Proxy endpoints for the FilaMan FilamentDB community database.

Provides search/lookup endpoints that proxy requests to db.filaman.app,
and a prepare-filament endpoint that auto-creates missing manufacturers
and colors locally before returning pre-filled data for the create form.
"""

import logging
from typing import Any

import httpx
from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel
from sqlalchemy import func, select

from app.api.deps import DBSession, PrincipalDep
from app.core.config import settings
from app.models import Color, FilamentColor, Manufacturer

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/filamentdb", tags=["FilamentDB Proxy"])

_TIMEOUT = 15.0  # seconds


async def _proxy_get(path: str, params: dict[str, Any] | None = None) -> Any:
    """Forward a GET request to the FilamentDB API."""
    url = f"{settings.filamentdb_url.rstrip('/')}/api/v1{path}"
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            resp = await client.get(url, params=params)
            resp.raise_for_status()
            return resp.json()
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


# ── Search endpoints (pure proxy) ──────────────────────────────────


@router.get("/manufacturers")
async def search_manufacturers(
    _principal: PrincipalDep,
    search: str | None = Query(None, min_length=2),
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
    search: str | None = Query(None, min_length=2),
    manufacturer_id: int | None = Query(None),
    material_key: str | None = Query(None),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
):
    """Search filaments in the FilamentDB community database."""
    params: dict[str, Any] = {"page": page, "page_size": page_size}
    if search:
        params["search"] = search
    if manufacturer_id is not None:
        params["manufacturer_id"] = manufacturer_id
    if material_key:
        params["material_key"] = material_key
    return await _proxy_get("/filaments", params)


@router.get("/spool-profiles")
async def search_spool_profiles(
    _principal: PrincipalDep,
    search: str | None = Query(None, min_length=2),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
):
    """Search spool profiles in the FilamentDB community database."""
    params: dict[str, Any] = {"page": page, "page_size": page_size}
    if search:
        params["search"] = search
    return await _proxy_get("/spool-profiles", params)


# ── Prepare endpoint (creates missing entities locally) ─────────────


class PrepareFilamentRequest(BaseModel):
    """Data from a FilamentDB filament record to prepare locally."""

    # Manufacturer info
    manufacturer_name: str
    manufacturer_website: str | None = None

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
