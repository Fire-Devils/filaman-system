from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.api.deps import DBSession, PrincipalDep, RequirePermission
from app.api.v1.schemas import PaginatedResponse
from app.api.v1.schemas_filament import (
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
    ManufacturerResponse,
    ManufacturerUpdate,
)
from app.models import Color, Filament, FilamentColor, Manufacturer, Spool

router = APIRouter(prefix="/manufacturers", tags=["manufacturers"])


@router.get("", response_model=PaginatedResponse[ManufacturerResponse])
async def list_manufacturers(
    db: DBSession,
    principal: PrincipalDep,
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
):
    result = await db.execute(
        select(Manufacturer)
        .order_by(Manufacturer.name)
        .offset((page - 1) * page_size)
        .limit(page_size)
    )
    items = list(result.scalars().all())

    mfr_ids = [m.id for m in items]
    fil_counts: dict[int, int] = {}
    spool_counts: dict[int, int] = {}
    materials_map: dict[int, list[str]] = {m.id: [] for m in items}

    if mfr_ids:
        fc_result = await db.execute(
            select(Filament.manufacturer_id, func.count(Filament.id))
            .where(Filament.manufacturer_id.in_(mfr_ids))
            .group_by(Filament.manufacturer_id)
        )
        fil_counts = {row[0]: row[1] for row in fc_result.all()}

        types_result = await db.execute(
            select(Filament.manufacturer_id, Filament.type)
            .where(Filament.manufacturer_id.in_(mfr_ids))
            .distinct()
        )
        for row in types_result.all():
            mfr_id, mat_type = row[0], row[1]
            if mfr_id in materials_map and mat_type:
                materials_map[mfr_id].append(mat_type)

        spool_result = await db.execute(
            select(Filament.manufacturer_id, func.count(Spool.id))
            .join(Filament, Spool.filament_id == Filament.id)
            .where(Filament.manufacturer_id.in_(mfr_ids))
            .where(Spool.deleted_at.is_(None))
            .group_by(Filament.manufacturer_id)
        )
        spool_counts = {row[0]: row[1] for row in spool_result.all()}

    items_out = [
        ManufacturerResponse.model_validate(
            {
                **m.__dict__,
                "filament_count": fil_counts.get(m.id, 0),
                "spool_count": spool_counts.get(m.id, 0),
                "materials": sorted(materials_map.get(m.id, [])),
            }
        )
        for m in items
    ]

    count_result = await db.execute(select(func.count()).select_from(Manufacturer))
    total = count_result.scalar() or 0

    return PaginatedResponse(items=items_out, page=page, page_size=page_size, total=total)


@router.post("", response_model=ManufacturerResponse, status_code=status.HTTP_201_CREATED)
async def create_manufacturer(
    data: ManufacturerCreate,
    db: DBSession,
    principal = RequirePermission("manufacturers:create"),
):
    result = await db.execute(select(Manufacturer).where(Manufacturer.name == data.name))
    if result.scalar_one_or_none():
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "conflict", "message": "Manufacturer with this name already exists"},
        )

    manufacturer = Manufacturer(**data.model_dump())
    db.add(manufacturer)
    await db.commit()
    await db.refresh(manufacturer)
    return manufacturer


@router.get("/{manufacturer_id}", response_model=ManufacturerResponse)
async def get_manufacturer(manufacturer_id: int, db: DBSession, principal: PrincipalDep):
    result = await db.execute(select(Manufacturer).where(Manufacturer.id == manufacturer_id))
    manufacturer = result.scalar_one_or_none()
    if not manufacturer:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "not_found", "message": "Manufacturer not found"},
        )
    return manufacturer


@router.patch("/{manufacturer_id}", response_model=ManufacturerResponse)
async def update_manufacturer(
    manufacturer_id: int,
    data: ManufacturerUpdate,
    db: DBSession,
    principal = RequirePermission("manufacturers:update"),
):
    result = await db.execute(select(Manufacturer).where(Manufacturer.id == manufacturer_id))
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
                detail={"code": "conflict", "message": "Manufacturer with this name already exists"},
            )

    for key, value in update_data.items():
        setattr(manufacturer, key, value)

    await db.commit()
    await db.refresh(manufacturer)
    return manufacturer


@router.delete("/{manufacturer_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_manufacturer(
    manufacturer_id: int,
    db: DBSession,
    principal = RequirePermission("manufacturers:delete"),
):
    result = await db.execute(select(Manufacturer).where(Manufacturer.id == manufacturer_id))
    manufacturer = result.scalar_one_or_none()
    if not manufacturer:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "not_found", "message": "Manufacturer not found"},
        )

    result = await db.execute(select(Filament).where(Filament.manufacturer_id == manufacturer_id).limit(1))
    if result.scalar_one_or_none():
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "conflict", "message": "Manufacturer has filaments, cannot delete"},
        )

    await db.delete(manufacturer)
    await db.commit()


router_colors = APIRouter(prefix="/colors", tags=["colors"])


@router_colors.get("", response_model=PaginatedResponse[ColorResponse])
async def list_colors(
    db: DBSession,
    principal: PrincipalDep,
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
):
    result = await db.execute(
        select(Color)
        .order_by(Color.name)
        .offset((page - 1) * page_size)
        .limit(page_size)
    )
    items = result.scalars().all()

    count_result = await db.execute(select(func.count()).select_from(Color))
    total = count_result.scalar() or 0

    return PaginatedResponse(items=items, page=page, page_size=page_size, total=total)


@router_colors.post("", response_model=ColorResponse, status_code=status.HTTP_201_CREATED)
async def create_color(
    data: ColorCreate,
    db: DBSession,
    principal = RequirePermission("colors:create"),
):
    color = Color(**data.model_dump())
    db.add(color)
    await db.commit()
    await db.refresh(color)
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
    principal = RequirePermission("colors:update"),
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
    return color


@router_colors.delete("/{color_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_color(
    color_id: int,
    db: DBSession,
    principal = RequirePermission("colors:delete"),
):
    result = await db.execute(select(Color).where(Color.id == color_id))
    color = result.scalar_one_or_none()
    if not color:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "not_found", "message": "Color not found"},
        )

    result = await db.execute(select(FilamentColor).where(FilamentColor.color_id == color_id).limit(1))
    if result.scalar_one_or_none():
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "conflict", "message": "Color is used by filaments, cannot delete"},
        )

    await db.delete(color)
    await db.commit()


router_filaments = APIRouter(prefix="/filaments", tags=["filaments"])

# Default filament types (always included in the types list)
DEFAULT_FILAMENT_TYPES = ["PLA", "PETG", "ABS", "ASA", "TPU", "NYLON", "PC"]


@router_filaments.get("/types", response_model=list[str])
async def list_filament_types(db: DBSession, principal: PrincipalDep):
    """Return all known filament types: defaults merged with distinct types from DB, sorted."""
    result = await db.execute(select(Filament.type).distinct())
    db_types = {row[0] for row in result.all() if row[0]}

    all_types = sorted(set(DEFAULT_FILAMENT_TYPES) | db_types)
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

    if type:
        query = query.where(Filament.type == type)
    if manufacturer_id:
        query = query.where(Filament.manufacturer_id == manufacturer_id)

    query = query.order_by(Filament.designation).offset((page - 1) * page_size).limit(page_size)

    result = await db.execute(query)
    items = result.scalars().unique().all()

    # Compute spool counts for the fetched filaments (excluding soft-deleted spools)
    filament_ids = [f.id for f in items]
    spool_counts: dict[int, int] = {}
    if filament_ids:
        spool_count_query = (
            select(Spool.filament_id, func.count(Spool.id))
            .where(Spool.filament_id.in_(filament_ids))
            .where(Spool.deleted_at.is_(None))
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

    count_query = select(func.count()).select_from(Filament)
    if type:
        count_query = count_query.where(Filament.type == type)
    if manufacturer_id:
        count_query = count_query.where(Filament.manufacturer_id == manufacturer_id)

    count_result = await db.execute(count_query)
    total = count_result.scalar() or 0

    return PaginatedResponse(items=items_with_count, page=page, page_size=page_size, total=total)


@router_filaments.post("", response_model=FilamentDetailResponse, status_code=status.HTTP_201_CREATED)
async def create_filament(
    data: FilamentCreate,
    db: DBSession,
    principal = RequirePermission("filaments:create"),
):
    # Separate colors from the filament data
    color_entries = data.colors or []
    filament_data = data.model_dump(exclude={"colors"})
    filament = Filament(**filament_data)
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

    # Compute spool count (excluding soft-deleted spools)
    spool_count_result = await db.execute(
        select(func.count(Spool.id))
        .where(Spool.filament_id == filament_id)
        .where(Spool.deleted_at.is_(None))
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


@router_filaments.patch("/{filament_id}", response_model=FilamentResponse)
async def update_filament(
    filament_id: int,
    data: FilamentUpdate,
    db: DBSession,
    principal = RequirePermission("filaments:update"),
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
    return filament


@router_filaments.put("/{filament_id}/colors", response_model=list[FilamentColorResponse])
async def replace_filament_colors(
    filament_id: int,
    data: FilamentColorsReplace,
    db: DBSession,
    principal = RequirePermission("filaments:update"),
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
    existing = await db.execute(
        select(FilamentColor).where(FilamentColor.filament_id == filament_id)
    )
    for fc in existing.scalars().all():
        await db.delete(fc)

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
    principal = RequirePermission("filaments:delete"),
):
    result = await db.execute(select(Filament).where(Filament.id == filament_id))
    filament = result.scalar_one_or_none()
    if not filament:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "not_found", "message": "Filament not found"},
        )

    from app.models import Spool

    result = await db.execute(select(Spool).where(Spool.filament_id == filament_id).limit(1))
    if result.scalar_one_or_none():
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "conflict", "message": "Filament has spools, cannot delete"},
        )

    await db.delete(filament)
    await db.commit()
