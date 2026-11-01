"""Minimal independently installed routes using the frozen v1 service."""

from app.api.deps import DBSession
from app.models.filament import Filament, FilamentColor
from app.models.spool import Spool
from fastapi import APIRouter
from sqlalchemy import select
from sqlalchemy.orm import selectinload

from . import schemas
from .service import SpoolmanService

router = APIRouter(prefix="/api/v1")


@router.get(
    "/filament/{filament_id}",
    response_model=schemas.Filament,
    response_model_exclude_none=True,
)
async def get_filament(filament_id: int, db: DBSession):
    filament = await db.scalar(
        select(Filament)
        .where(Filament.id == filament_id)
        .options(
            selectinload(Filament.manufacturer),
            selectinload(Filament.filament_colors).selectinload(FilamentColor.color),
        )
    )
    return SpoolmanService(db)._filament_to_schema(filament)


@router.get(
    "/spool/{spool_id}", response_model=schemas.Spool, response_model_exclude_none=True
)
async def get_spool(spool_id: int, db: DBSession):
    spool = await db.scalar(
        select(Spool)
        .where(Spool.id == spool_id)
        .options(
            selectinload(Spool.filament).selectinload(Filament.manufacturer),
            selectinload(Spool.filament)
            .selectinload(Filament.filament_colors)
            .selectinload(FilamentColor.color),
            selectinload(Spool.location),
            selectinload(Spool.status),
        )
    )
    return SpoolmanService(db)._spool_to_schema(spool)
