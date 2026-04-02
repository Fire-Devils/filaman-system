import asyncio
import ipaddress
import logging
import mimetypes
from pathlib import Path
import socket
from typing import Any

import httpx
from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile, status
from fastapi.responses import FileResponse
from sqlalchemy import delete, func, select, literal_column
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.api.deps import DBSession, PrincipalDep, RequirePermission
from app.core.cache import response_cache
from app.core.db_utils import get_next_available_id
from app.api.v1.schemas import PaginatedResponse
from app.api.v1.schemas_filament import (
    BulkFilamentDeleteRequest,
    BulkFilamentUpdateRequest,
    ColorCreate,
    ColorResponse,
    ColorUpdate,
    FilamentColorEntry,
    FilamentColorResponse,
    FilamentColorsReplace,
    FilamentCreate,
    FilamentDetailResponse,
    FilamentResponse,
    FilamentUpdate,
    ManufacturerCreate,
    ManufacturerLogoImportRequest,
    ManufacturerResponse,
    ManufacturerUpdate,
)
from app.core.event_bus import event_bus
from app.models import Color, Filament, FilamentColor, Manufacturer, Spool, SpoolStatus
from app.services.manufacturer_logo_service import (
    CONTENT_TYPE_SUFFIXES,
    MAX_LOGO_SIZE_BYTES,
    delete_manufacturer_logo,
    resolve_logo_file_path,
    save_manufacturer_logo,
    sniff_logo_suffix,
)

router = APIRouter(prefix="/manufacturers", tags=["manufacturers"])
logger = logging.getLogger(__name__)

_SAFE_LOGO_IMPORT_SCHEMES = {"http", "https"}
_MAX_LOGO_REDIRECTS = 5
_SUPPORTED_LOGO_TYPES = "PNG, JPEG, GIF, or WebP"


async def _resolve_hostname_ips(host: str) -> set[str]:
    def _lookup() -> set[str]:
        resolved_ips: set[str] = set()
        for family, _, _, _, sockaddr in socket.getaddrinfo(host, None, type=socket.SOCK_STREAM):
            if family == socket.AF_INET:
                resolved_ips.add(sockaddr[0])
            elif family == socket.AF_INET6:
                resolved_ips.add(sockaddr[0])
        return resolved_ips

    try:
        return await asyncio.to_thread(_lookup)
    except socket.gaierror as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"code": "invalid_logo_url", "message": f"Unable to resolve logo host: {exc}"},
        ) from exc


def _build_host_header(url: httpx.URL) -> str:
    if url.port and url.port not in {80, 443}:
        return f"{url.host}:{url.port}"
    return url.host


def _validate_logo_bytes(file_bytes: bytes, content_type: str | None) -> str:
    normalized_content_type = (content_type or "").split(";", 1)[0].strip().lower()
    if normalized_content_type not in CONTENT_TYPE_SUFFIXES:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={
                "code": "invalid_content_type",
                "message": f"Expected a {_SUPPORTED_LOGO_TYPES} image",
            },
        )

    if not file_bytes:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"code": "empty_file", "message": "Empty file"},
        )

    if len(file_bytes) > MAX_LOGO_SIZE_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail={
                "code": "file_too_large",
                "message": "Logo must be 5 MB or smaller",
            },
        )

    detected_suffix = sniff_logo_suffix(file_bytes)
    if detected_suffix is None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={
                "code": "invalid_image",
                "message": f"File is not a valid {_SUPPORTED_LOGO_TYPES} image",
            },
        )

    expected_suffix = CONTENT_TYPE_SUFFIXES[normalized_content_type]
    if expected_suffix != detected_suffix:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={
                "code": "invalid_image",
                "message": "File contents do not match the reported image type",
            },
        )

    return detected_suffix


async def _validate_logo_source_url(url: httpx.URL) -> None:
    if url.scheme not in _SAFE_LOGO_IMPORT_SCHEMES or not url.host:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"code": "invalid_logo_url", "message": "Logo URL must use http or https"},
        )

    if url.userinfo:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"code": "invalid_logo_url", "message": "Logo URL must not include credentials"},
        )

    host = url.host.lower()
    if host == "localhost" or host.endswith(".localhost"):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"code": "unsafe_logo_url", "message": "Logo URL must not target local or private hosts"},
        )

    resolved_ips = await _resolve_hostname_ips(host)
    if not resolved_ips:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"code": "invalid_logo_url", "message": "Unable to resolve logo host"},
        )

    for resolved_ip in resolved_ips:
        ip = ipaddress.ip_address(resolved_ip)
        if (
            ip.is_private
            or ip.is_loopback
            or ip.is_link_local
            or ip.is_multicast
            or ip.is_reserved
            or ip.is_unspecified
        ):
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail={"code": "unsafe_logo_url", "message": "Logo URL must not target local or private hosts"},
            )


async def _read_logo_response_bytes(response: httpx.Response) -> bytes:
    content_length = response.headers.get("content-length")
    if content_length:
        try:
            if int(content_length) > MAX_LOGO_SIZE_BYTES:
                raise HTTPException(
                    status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                    detail={
                        "code": "file_too_large",
                        "message": "Logo must be 5 MB or smaller",
                    },
                )
        except ValueError:
            pass

    file_bytes = bytearray()
    async for chunk in response.aiter_bytes(chunk_size=8192):
        file_bytes.extend(chunk)
        if len(file_bytes) > MAX_LOGO_SIZE_BYTES:
            raise HTTPException(
                status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                detail={
                    "code": "file_too_large",
                    "message": "Logo must be 5 MB or smaller",
                },
            )

    return bytes(file_bytes)


async def _fetch_logo_from_url(logo_url: str) -> tuple[bytes, str, str | None, str]:
    current_url = httpx.URL(logo_url)

    async with httpx.AsyncClient(
        follow_redirects=False,
        timeout=httpx.Timeout(20.0, connect=5.0, read=10.0, write=10.0, pool=5.0),
        trust_env=False,
        headers={
            "User-Agent": (
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Safari/537.36"
            ),
            "Accept": "image/png,image/jpeg,image/gif,image/webp,image/*;q=0.8,*/*;q=0.5",
        },
    ) as client:
        for _ in range(_MAX_LOGO_REDIRECTS + 1):
            await _validate_logo_source_url(current_url)
            resolved_ips = sorted(await _resolve_hostname_ips(current_url.host))
            request_url = current_url.copy_with(host=resolved_ips[0])
            host_header = _build_host_header(current_url)
            request = client.build_request(
                "GET",
                request_url,
                headers={
                    "Host": host_header,
                    "Referer": f"{current_url.scheme}://{host_header}/",
                },
                extensions=(
                    {"sni_hostname": current_url.host}
                    if current_url.scheme == "https"
                    else None
                ),
            )
            response = await client.send(request, stream=True)

            try:
                if response.is_redirect:
                    location = response.headers.get("location")
                    if not location:
                        raise HTTPException(
                            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                            detail={
                                "code": "logo_fetch_failed",
                                "message": "Logo URL redirect was missing a location header",
                            },
                        )
                    current_url = current_url.join(location)
                    continue

                response.raise_for_status()
                content_type = response.headers.get("content-type", "").split(";", 1)[0].strip().lower()
                file_bytes = await _read_logo_response_bytes(response)
                detected_suffix = _validate_logo_bytes(file_bytes, content_type)
                fallback_name = f"logo{detected_suffix}"
                return file_bytes, content_type, Path(current_url.path).name or fallback_name, detected_suffix
            except httpx.HTTPStatusError as exc:
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                    detail={
                        "code": "logo_fetch_failed",
                        "message": f"Failed to fetch logo from URL: {exc}",
                    },
                ) from exc
            finally:
                await response.aclose()

    raise HTTPException(
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        detail={"code": "logo_fetch_failed", "message": "Logo URL redirected too many times"},
    )


async def _commit_manufacturer_logo_change(
    *,
    db: AsyncSession,
    manufacturer: Manufacturer,
    new_logo_path: str | None,
) -> Manufacturer:
    previous_logo_path = manufacturer.logo_file_path
    manufacturer.logo_file_path = new_logo_path

    try:
        await db.commit()
    except Exception:
        await db.rollback()
        if new_logo_path and new_logo_path != previous_logo_path:
            try:
                delete_manufacturer_logo(new_logo_path)
            except (OSError, ValueError) as cleanup_exc:
                logger.warning("Failed to clean up new manufacturer logo %s: %s", new_logo_path, cleanup_exc)
        raise

    await db.refresh(manufacturer)

    if previous_logo_path and previous_logo_path != new_logo_path:
        try:
            delete_manufacturer_logo(previous_logo_path)
        except (OSError, ValueError) as cleanup_exc:
            logger.warning("Failed to delete previous manufacturer logo %s: %s", previous_logo_path, cleanup_exc)

    return manufacturer


@router.get("/logo-files/{filename}")
async def get_manufacturer_logo_file(filename: str, principal: PrincipalDep):
    stored_path = f"manufacturer-logos/{Path(filename).name}"
    try:
        file_path = resolve_logo_file_path(stored_path)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "not_found", "message": "Manufacturer logo not found"},
        ) from exc

    if not file_path.exists() or not file_path.is_file():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "not_found", "message": "Manufacturer logo not found"},
        )
    media_type, _ = mimetypes.guess_type(file_path.name)
    return FileResponse(
        file_path,
        media_type=media_type or "application/octet-stream",
        headers={"X-Content-Type-Options": "nosniff"},
    )


@router.get("", response_model=PaginatedResponse[ManufacturerResponse])
async def list_manufacturers(
    db: DBSession,
    principal: PrincipalDep,
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
):
    # Base query for manufacturers
    query = select(Manufacturer).order_by(Manufacturer.name)

    # Executing the pagination slice
    result = await db.execute(query.offset((page - 1) * page_size).limit(page_size))
    items = list(result.scalars().all())

    mfr_ids = [m.id for m in items]
    fil_counts: dict[int, int] = {}
    active_spool_counts: dict[int, int] = {}
    archived_spool_counts: dict[int, int] = {}
    total_price_available: dict[int, float] = {}
    total_price_all: dict[int, float] = {}
    materials_map: dict[int, list[str]] = {m.id: [] for m in items}

    if mfr_ids:
        # Run the count queries sequentially (same AsyncSession cannot run concurrent queries)

        fc_stmt = (
            select(Filament.manufacturer_id, func.count(Filament.id))
            .where(Filament.manufacturer_id.in_(mfr_ids))
            .group_by(Filament.manufacturer_id)
        )
        types_stmt = (
            select(Filament.manufacturer_id, Filament.material_type)
            .where(Filament.manufacturer_id.in_(mfr_ids))
            .distinct()
        )

        # Comprehensive spool stats query
        # We need sum of prices and counts for both active and archived
        spool_stats_stmt = (
            select(
                Filament.manufacturer_id,
                func.count(Spool.id)
                .filter(SpoolStatus.key != "archived")
                .label("active_count"),
                func.count(Spool.id)
                .filter(SpoolStatus.key == "archived")
                .label("archived_count"),
                func.sum(Spool.purchase_price)
                .filter(SpoolStatus.key != "archived")
                .label("active_price"),
                func.sum(Spool.purchase_price).label("total_price"),
            )
            .join(Spool, Spool.filament_id == Filament.id)
            .join(SpoolStatus, Spool.status_id == SpoolStatus.id)
            .where(Filament.manufacturer_id.in_(mfr_ids))
            .group_by(Filament.manufacturer_id)
        )

        fc_result = await db.execute(fc_stmt)
        types_result = await db.execute(types_stmt)
        spool_stats_result = await db.execute(spool_stats_stmt)

        fil_counts = {row[0]: row[1] for row in fc_result.all()}

        for row in types_result.all():
            mfr_id, mat_type = row[0], row[1]
            if mfr_id in materials_map and mat_type:
                materials_map[mfr_id].append(mat_type)

        for row in spool_stats_result.all():
            mfr_id, active_c, archived_c, active_p, total_p = row
            active_spool_counts[mfr_id] = active_c or 0
            archived_spool_counts[mfr_id] = archived_c or 0
            total_price_available[mfr_id] = active_p or 0.0
            total_price_all[mfr_id] = total_p or 0.0

    items_out = [
        ManufacturerResponse.model_validate(
            {
                **m.__dict__,
                "resolved_logo_url": m.resolved_logo_url,
                "filament_count": fil_counts.get(m.id, 0),
                "spool_count": active_spool_counts.get(m.id, 0),
                "archived_spool_count": archived_spool_counts.get(m.id, 0),
                "total_price_available": total_price_available.get(m.id, 0.0),
                "total_price_all": total_price_all.get(m.id, 0.0),
                "materials": sorted(materials_map.get(m.id, [])),
            }
        )
        for m in items
    ]

    count_result = await db.execute(select(func.count()).select_from(Manufacturer))
    total = count_result.scalar() or 0

    return PaginatedResponse(
        items=items_out, page=page, page_size=page_size, total=total
    )


@router.post(
    "", response_model=ManufacturerResponse, status_code=status.HTTP_201_CREATED
)
async def create_manufacturer(
    data: ManufacturerCreate,
    db: DBSession,
    principal=RequirePermission("manufacturers:create"),
):
    result = await db.execute(
        select(Manufacturer).where(Manufacturer.name == data.name)
    )
    if result.scalar_one_or_none():
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "code": "conflict",
                "message": "Manufacturer with this name already exists",
            },
        )

    next_id = await get_next_available_id(db, Manufacturer)
    manufacturer = Manufacturer(id=next_id, **data.model_dump())
    db.add(manufacturer)
    await db.commit()
    await db.refresh(manufacturer)
    await event_bus.publish({"event": "manufacturers_changed"})
    return manufacturer


@router.post("/{manufacturer_id}/logo-from-url", response_model=ManufacturerResponse)
async def import_manufacturer_logo_from_url(
    manufacturer_id: int,
    data: ManufacturerLogoImportRequest,
    db: DBSession,
    principal=RequirePermission("manufacturers:update"),
):
    result = await db.execute(
        select(Manufacturer).where(Manufacturer.id == manufacturer_id)
    )
    manufacturer = result.scalar_one_or_none()
    if not manufacturer:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "not_found", "message": "Manufacturer not found"},
        )

    source_url = (data.url or "").strip()
    if not source_url:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"code": "invalid_logo_url", "message": "Logo URL is required"},
        )

    try:
        file_bytes, content_type, fetched_filename, detected_suffix = await _fetch_logo_from_url(source_url)
    except HTTPException:
        raise
    except httpx.HTTPError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"code": "logo_fetch_failed", "message": f"Failed to fetch logo from URL: {exc}"},
        ) from exc

    new_logo_path = save_manufacturer_logo(
        manufacturer_name=manufacturer.name,
        file_bytes=file_bytes,
        filename=fetched_filename,
        content_type=content_type,
        detected_suffix=detected_suffix,
    )

    manufacturer = await _commit_manufacturer_logo_change(
        db=db,
        manufacturer=manufacturer,
        new_logo_path=new_logo_path,
    )

    await event_bus.publish({"event": "manufacturers_changed"})
    return manufacturer


@router.post("/{manufacturer_id}/logo", response_model=ManufacturerResponse)
async def upload_manufacturer_logo(
    manufacturer_id: int,
    db: DBSession,
    file: UploadFile = File(...),
    principal=RequirePermission("manufacturers:update"),
):
    result = await db.execute(
        select(Manufacturer).where(Manufacturer.id == manufacturer_id)
    )
    manufacturer = result.scalar_one_or_none()
    if not manufacturer:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "not_found", "message": "Manufacturer not found"},
        )

    try:
        file_bytes = await file.read(MAX_LOGO_SIZE_BYTES + 1)
    finally:
        await file.close()

    detected_suffix = _validate_logo_bytes(file_bytes, file.content_type)
    new_logo_path = save_manufacturer_logo(
        manufacturer_name=manufacturer.name,
        file_bytes=file_bytes,
        filename=file.filename,
        content_type=file.content_type,
        detected_suffix=detected_suffix,
    )

    manufacturer = await _commit_manufacturer_logo_change(
        db=db,
        manufacturer=manufacturer,
        new_logo_path=new_logo_path,
    )

    await event_bus.publish({"event": "manufacturers_changed"})
    return manufacturer


@router.get("/{manufacturer_id}", response_model=ManufacturerResponse)
async def get_manufacturer(
    manufacturer_id: int, db: DBSession, principal: PrincipalDep
):
    result = await db.execute(
        select(Manufacturer).where(Manufacturer.id == manufacturer_id)
    )
    manufacturer = result.scalar_one_or_none()
    if not manufacturer:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "not_found", "message": "Manufacturer not found"},
        )
    return manufacturer


@router.delete("/{manufacturer_id}/logo", response_model=ManufacturerResponse)
async def delete_manufacturer_logo_file(
    manufacturer_id: int,
    db: DBSession,
    principal=RequirePermission("manufacturers:update"),
):
    result = await db.execute(
        select(Manufacturer).where(Manufacturer.id == manufacturer_id)
    )
    manufacturer = result.scalar_one_or_none()
    if not manufacturer:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "not_found", "message": "Manufacturer not found"},
        )

    manufacturer = await _commit_manufacturer_logo_change(
        db=db,
        manufacturer=manufacturer,
        new_logo_path=None,
    )
    await event_bus.publish({"event": "manufacturers_changed"})
    return manufacturer


@router.patch("/{manufacturer_id}", response_model=ManufacturerResponse)
async def update_manufacturer(
    manufacturer_id: int,
    data: ManufacturerUpdate,
    db: DBSession,
    principal=RequirePermission("manufacturers:update"),
):
    result = await db.execute(
        select(Manufacturer).where(Manufacturer.id == manufacturer_id)
    )
    manufacturer = result.scalar_one_or_none()
    if not manufacturer:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "not_found", "message": "Manufacturer not found"},
        )

    update_data = data.model_dump(exclude_unset=True)

    if "name" in update_data and update_data["name"] != manufacturer.name:
        existing = await db.execute(
            select(Manufacturer).where(Manufacturer.name == update_data["name"])
        )
        if existing.scalar_one_or_none():
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail={
                    "code": "conflict",
                    "message": "Manufacturer with this name already exists",
                },
            )

    for key, value in update_data.items():
        setattr(manufacturer, key, value)

    await db.commit()
    await db.refresh(manufacturer)
    await event_bus.publish({"event": "manufacturers_changed"})
    return manufacturer


@router.delete("/{manufacturer_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_manufacturer(
    manufacturer_id: int,
    db: DBSession,
    principal=RequirePermission("manufacturers:delete"),
    force: bool = False,
):
    result = await db.execute(
        select(Manufacturer).where(Manufacturer.id == manufacturer_id)
    )
    manufacturer = result.scalar_one_or_none()
    if not manufacturer:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "not_found", "message": "Manufacturer not found"},
        )

    result = await db.execute(
        select(Filament).where(Filament.manufacturer_id == manufacturer_id).limit(1)
    )
    if result.scalar_one_or_none():
        if not force:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail={
                    "code": "conflict",
                    "message": "Manufacturer has filaments, cannot delete without force flag",
                },
            )
        else:
            # If force is true, we delete the spools first
            # The filament deletion is handled by cascade delete in the DB if configured,
            # or we do it explicitly. SQLAlchemy often handles relationships, but let's be safe:
            filaments_result = await db.execute(
                select(Filament).where(Filament.manufacturer_id == manufacturer_id)
            )
            filaments_to_delete = filaments_result.scalars().all()
            for f in filaments_to_delete:
                # Delete associated spools first
                from app.models import Spool

                spools_result = await db.execute(
                    select(Spool).where(Spool.filament_id == f.id)
                )
                spools_to_delete = spools_result.scalars().all()
                for s in spools_to_delete:
                    await db.delete(s)
                await db.delete(f)

    logo_to_delete = manufacturer.logo_file_path
    await db.delete(manufacturer)
    await db.commit()

    if logo_to_delete:
        try:
            delete_manufacturer_logo(logo_to_delete)
        except (OSError, ValueError) as cleanup_exc:
            logger.warning("Failed to delete manufacturer logo %s: %s", logo_to_delete, cleanup_exc)

    await event_bus.publish({"event": "manufacturers_changed"})


router_colors = APIRouter(prefix="/colors", tags=["colors"])


@router_colors.get("", response_model=PaginatedResponse[ColorResponse])
async def list_colors(
    db: DBSession,
    principal: PrincipalDep,
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
):
    # Select colors with usage count
    # Note: FilamentColor links Color to Filament
    query = (
        select(Color, func.count(FilamentColor.id).label("usage_count"))
        .outerjoin(FilamentColor, Color.id == FilamentColor.color_id)
        .group_by(Color.id)
        .order_by(Color.name)
        .offset((page - 1) * page_size)
        .limit(page_size)
    )

    result = await db.execute(query)
    rows = result.all()

    items = []
    for color, usage_count in rows:
        # Convert to dict to include usage_count in the response model validation
        color_dict = {**color.__dict__}
        color_dict["usage_count"] = usage_count
        items.append(ColorResponse.model_validate(color_dict))

    count_result = await db.execute(select(func.count()).select_from(Color))
    total = count_result.scalar() or 0

    return PaginatedResponse(items=items, page=page, page_size=page_size, total=total)


@router_colors.post(
    "", response_model=ColorResponse, status_code=status.HTTP_201_CREATED
)
async def create_color(
    data: ColorCreate,
    db: DBSession,
    principal=RequirePermission("colors:create"),
):
    color = Color(**data.model_dump())
    db.add(color)
    await db.commit()
    await db.refresh(color)
    await event_bus.publish({"event": "colors_changed"})
    return color


@router_colors.get("/{color_id}", response_model=ColorResponse)
async def get_color(color_id: int, db: DBSession, principal: PrincipalDep):
    result = await db.execute(select(Color).where(Color.id == color_id))
    color = result.scalar_one_or_none()
    if not color:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "not_found", "message": "Color not found"},
        )
    return color


@router_colors.patch("/{color_id}", response_model=ColorResponse)
async def update_color(
    color_id: int,
    data: ColorUpdate,
    db: DBSession,
    principal=RequirePermission("colors:update"),
):
    result = await db.execute(select(Color).where(Color.id == color_id))
    color = result.scalar_one_or_none()
    if not color:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "not_found", "message": "Color not found"},
        )

    for key, value in data.model_dump(exclude_unset=True).items():
        setattr(color, key, value)

    await db.commit()
    await db.refresh(color)
    await event_bus.publish({"event": "colors_changed"})
    return color


@router_colors.delete("/{color_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_color(
    color_id: int,
    db: DBSession,
    principal=RequirePermission("colors:delete"),
):
    result = await db.execute(select(Color).where(Color.id == color_id))
    color = result.scalar_one_or_none()
    if not color:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "not_found", "message": "Color not found"},
        )

    result = await db.execute(
        select(FilamentColor).where(FilamentColor.color_id == color_id).limit(1)
    )
    if result.scalar_one_or_none():
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "code": "conflict",
                "message": "Color is used by filaments, cannot delete",
            },
        )

    await db.delete(color)
    await db.commit()
    await event_bus.publish({"event": "colors_changed"})


router_filaments = APIRouter(prefix="/filaments", tags=["filaments"])

# Default filament types (always included in the types list)
DEFAULT_FILAMENT_TYPES = ["PLA", "PETG", "ABS", "ASA", "TPU", "NYLON", "PC"]


@router_filaments.get("/types", response_model=list[str])
async def list_filament_types(db: DBSession, principal: PrincipalDep):
    """Return all known filament types: defaults merged with distinct types from DB, sorted."""
    cached = response_cache.get("filament_types")
    if cached is not None:
        return cached

    result = await db.execute(select(Filament.material_type).distinct())
    db_types = {row[0] for row in result.all() if row[0]}

    all_types = sorted(set(DEFAULT_FILAMENT_TYPES) | db_types)
    response_cache.set("filament_types", all_types, ttl=600)
    return all_types


@router_filaments.get("", response_model=PaginatedResponse[FilamentDetailResponse])
async def list_filaments(
    db: DBSession,
    principal: PrincipalDep,
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    type: str | None = None,
    manufacturer_id: int | None = None,
):
    query = select(Filament).options(
        selectinload(Filament.manufacturer),
        selectinload(Filament.filament_colors).selectinload(FilamentColor.color),
    )

    count_query = select(func.count()).select_from(Filament)

    if type:
        query = query.where(Filament.material_type == type)
        count_query = count_query.where(Filament.material_type == type)
    if manufacturer_id:
        query = query.where(Filament.manufacturer_id == manufacturer_id)
        count_query = count_query.where(Filament.manufacturer_id == manufacturer_id)

    query = (
        query.order_by(Filament.designation)
        .offset((page - 1) * page_size)
        .limit(page_size)
    )

    result = await db.execute(query)
    count_result = await db.execute(count_query)

    items = result.scalars().unique().all()
    total = count_result.scalar() or 0

    # Compute spool counts for the fetched filaments (excluding soft-deleted spools)
    filament_ids = [f.id for f in items]
    spool_counts: dict[int, int] = {}
    if filament_ids:
        spool_count_query = (
            select(Spool.filament_id, func.count(Spool.id))
            .join(SpoolStatus, Spool.status_id == SpoolStatus.id)
            .where(Spool.filament_id.in_(filament_ids))
            .where(SpoolStatus.key != "archived")
            .group_by(Spool.filament_id)
        )
        spool_result = await db.execute(spool_count_query)
        spool_counts = {row[0]: row[1] for row in spool_result.all()}

    items_with_count = [
        FilamentDetailResponse.model_validate(
            {
                **f.__dict__,
                "manufacturer": f.manufacturer,
                "spool_count": spool_counts.get(f.id, 0),
                "colors": sorted(f.filament_colors, key=lambda fc: fc.position),
            }
        )
        for f in items
    ]

    return PaginatedResponse(
        items=items_with_count, page=page, page_size=page_size, total=total
    )


@router_filaments.post(
    "", response_model=FilamentDetailResponse, status_code=status.HTTP_201_CREATED
)
async def create_filament(
    data: FilamentCreate,
    db: DBSession,
    principal=RequirePermission("filaments:create"),
):
    # Fetch manufacturer to cascade properties if they are not provided
    m_result = await db.execute(
        select(Manufacturer).where(Manufacturer.id == data.manufacturer_id)
    )
    manufacturer = m_result.scalar_one_or_none()
    if manufacturer:
        if data.default_spool_weight_g is None:
            data.default_spool_weight_g = manufacturer.empty_spool_weight_g
        if data.spool_outer_diameter_mm is None:
            data.spool_outer_diameter_mm = manufacturer.spool_outer_diameter_mm
        if data.spool_width_mm is None:
            data.spool_width_mm = manufacturer.spool_width_mm
        if data.spool_material is None:
            data.spool_material = manufacturer.spool_material

    # Separate colors from the filament data
    color_entries = data.colors or []
    filament_data = data.model_dump(exclude={"colors"})
    next_id = await get_next_available_id(db, Filament)
    filament = Filament(id=next_id, **filament_data)
    db.add(filament)
    await db.flush()  # get filament.id

    # Create filament_colors
    for entry in color_entries:
        fc = FilamentColor(
            filament_id=filament.id,
            color_id=entry.color_id,
            position=entry.position,
            display_name_override=entry.display_name_override,
        )
        db.add(fc)

    await db.commit()
    await event_bus.publish({"event": "filaments_changed"})
    response_cache.delete("filament_types")

    # Reload with relationships
    result = await db.execute(
        select(Filament)
        .where(Filament.id == filament.id)
        .options(
            selectinload(Filament.manufacturer),
            selectinload(Filament.filament_colors).selectinload(FilamentColor.color),
        )
    )
    filament = result.scalar_one()

    return FilamentDetailResponse.model_validate(
        {
            **filament.__dict__,
            "manufacturer": filament.manufacturer,
            "spool_count": 0,
            "colors": sorted(filament.filament_colors, key=lambda fc: fc.position),
        }
    )


@router_filaments.get("/{filament_id}", response_model=FilamentDetailResponse)
async def get_filament(filament_id: int, db: DBSession, principal: PrincipalDep):
    result = await db.execute(
        select(Filament)
        .where(Filament.id == filament_id)
        .options(
            selectinload(Filament.manufacturer),
            selectinload(Filament.filament_colors).selectinload(FilamentColor.color),
        )
    )
    filament = result.scalar_one_or_none()
    if not filament:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "not_found", "message": "Filament not found"},
        )

    # Compute spool count (excluding archived spools)
    spool_count_result = await db.execute(
        select(func.count(Spool.id))
        .join(SpoolStatus, Spool.status_id == SpoolStatus.id)
        .where(Spool.filament_id == filament_id)
        .where(SpoolStatus.key != "archived")
    )
    spool_count = spool_count_result.scalar() or 0

    return FilamentDetailResponse.model_validate(
        {
            **filament.__dict__,
            "manufacturer": filament.manufacturer,
            "spool_count": spool_count,
            "colors": sorted(filament.filament_colors, key=lambda fc: fc.position),
        }
    )


@router_filaments.patch("/bulk", status_code=status.HTTP_200_OK)
async def update_filaments_bulk(
    data: BulkFilamentUpdateRequest,
    db: DBSession,
    principal=RequirePermission("filaments:update"),
):
    """Bulk update fields on multiple filaments (price, diameter, spool weight, density)."""
    result = await db.execute(
        select(Filament).where(Filament.id.in_(data.filament_ids))
    )
    filaments = result.scalars().all()

    count = 0
    for filament in filaments:
        if data.price is not None:
            filament.price = data.price
        if data.diameter_mm is not None:
            filament.diameter_mm = data.diameter_mm
        if data.default_spool_weight_g is not None:
            filament.default_spool_weight_g = data.default_spool_weight_g
        if data.density_g_cm3 is not None:
            filament.density_g_cm3 = data.density_g_cm3
        count += 1

    await db.commit()
    await event_bus.publish({"event": "filaments_changed"})
    response_cache.delete("filament_types")
    return {"success": True, "count": count}


@router_filaments.delete("/bulk", status_code=status.HTTP_200_OK)
async def delete_filaments_bulk(
    data: BulkFilamentDeleteRequest,
    db: DBSession,
    principal=RequirePermission("filaments:delete"),
):
    """Bulk delete multiple filaments. Use force=true to cascade-delete associated spools."""
    filament_ids = list(data.filament_ids)

    # Find which filaments have associated spools
    spool_check = await db.execute(
        select(Spool.filament_id).where(Spool.filament_id.in_(filament_ids)).distinct()
    )
    filament_ids_with_spools = set(spool_check.scalars().all())

    if data.force:
        # Force: delete spools for all filaments that have them, then delete all filaments
        if filament_ids_with_spools:
            await db.execute(
                delete(Spool).where(Spool.filament_id.in_(filament_ids_with_spools))
            )
        result = await db.execute(delete(Filament).where(Filament.id.in_(filament_ids)))
        count = result.rowcount
    else:
        # Skip filaments that have spools
        ids_to_delete = [
            fid for fid in filament_ids if fid not in filament_ids_with_spools
        ]
        if ids_to_delete:
            result = await db.execute(
                delete(Filament).where(Filament.id.in_(ids_to_delete))
            )
            count = result.rowcount
        else:
            count = 0

    await db.commit()
    await event_bus.publish({"event": "filaments_changed"})
    response_cache.delete("filament_types")
    return {"success": True, "count": count}


@router_filaments.patch("/{filament_id}", response_model=FilamentResponse)
async def update_filament(
    filament_id: int,
    data: FilamentUpdate,
    db: DBSession,
    principal=RequirePermission("filaments:update"),
):
    result = await db.execute(select(Filament).where(Filament.id == filament_id))
    filament = result.scalar_one_or_none()
    if not filament:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "not_found", "message": "Filament not found"},
        )

    for key, value in data.model_dump(exclude_unset=True).items():
        setattr(filament, key, value)

    await db.commit()
    await db.refresh(filament)
    await event_bus.publish({"event": "filaments_changed"})
    response_cache.delete("filament_types")
    return filament


@router_filaments.put(
    "/{filament_id}/colors", response_model=list[FilamentColorResponse]
)
async def replace_filament_colors(
    filament_id: int,
    data: FilamentColorsReplace,
    db: DBSession,
    principal=RequirePermission("filaments:update"),
):
    """Replace all color assignments for a filament (spec: PUT /filaments/{id}/colors)."""
    result = await db.execute(select(Filament).where(Filament.id == filament_id))
    filament = result.scalar_one_or_none()
    if not filament:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "not_found", "message": "Filament not found"},
        )

    # Update color_mode and multi_color_style on the filament
    filament.color_mode = data.color_mode
    filament.multi_color_style = data.multi_color_style

    # Delete existing filament_colors
    await db.execute(
        delete(FilamentColor).where(FilamentColor.filament_id == filament_id)
    )

    await db.flush()

    # Create new color entries
    new_colors = []
    for entry in data.colors:
        fc = FilamentColor(
            filament_id=filament_id,
            color_id=entry.color_id,
            position=entry.position,
            display_name_override=entry.display_name_override,
        )
        db.add(fc)
        new_colors.append(fc)

    try:
        await db.commit()
    except Exception as e:
        await db.rollback()
        raise HTTPException(
            status_code=400,
            detail={"code": "color_update_failed", "message": str(e)},
        )
    await event_bus.publish({"event": "filaments_changed"})
    response_cache.delete("filament_types")

    # Reload with color relationships
    result = await db.execute(
        select(FilamentColor)
        .where(FilamentColor.filament_id == filament_id)
        .options(selectinload(FilamentColor.color))
        .order_by(FilamentColor.position)
    )
    return result.scalars().all()


@router_filaments.delete("/{filament_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_filament(
    filament_id: int,
    db: DBSession,
    principal=RequirePermission("filaments:delete"),
    force: bool = False,
):
    result = await db.execute(select(Filament).where(Filament.id == filament_id))
    filament = result.scalar_one_or_none()
    if not filament:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "not_found", "message": "Filament not found"},
        )

    from app.models import Spool

    result = await db.execute(
        select(Spool).where(Spool.filament_id == filament_id).limit(1)
    )
    if result.scalar_one_or_none():
        if not force:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail={
                    "code": "conflict",
                    "message": "Filament has spools, cannot delete without force flag",
                },
            )
        else:
            # Force delete all spools associated with this filament
            spools_result = await db.execute(
                select(Spool).where(Spool.filament_id == filament_id)
            )
            for s in spools_result.scalars().all():
                await db.delete(s)

    await db.delete(filament)
    await db.commit()
    await event_bus.publish({"event": "filaments_changed"})
    response_cache.delete("filament_types")
