"""Minimal independently installed routes using the frozen v1 service."""

import csv
import io

from app.api.deps import DBSession
from app.models.filament import Filament, FilamentColor
from app.models.spool import Spool
from fastapi import APIRouter
from fastapi.responses import Response
from sqlalchemy import select
from sqlalchemy.orm import selectinload

from . import schemas
from .service import SpoolmanService

router = APIRouter(prefix="/api/v1")


@router.get("/field/{entity_type}")
async def get_extra_fields(entity_type: str, db: DBSession):
    return await SpoolmanService(db).get_extra_fields(entity_type)


@router.get("/health")
async def health_check():
    return {"status": "healthy"}


@router.get("/export/filaments")
async def export_filaments(fmt: str, db: DBSession):
    return _download(await SpoolmanService(db).export_filaments(), fmt)


@router.get("/export/spools")
async def export_spools(fmt: str, db: DBSession):
    return _download(await SpoolmanService(db).export_spools(), fmt)


def _download(rows, fmt):
    if fmt == "json":
        return rows
    output = io.StringIO()
    writer = csv.DictWriter(output, fieldnames=rows[0])
    writer.writeheader()
    writer.writerows(rows)
    return Response(output.getvalue(), media_type="text/csv")


@router.post("/filament", response_model=schemas.Filament, response_model_exclude_none=True)
async def create_filament(data: schemas.FilamentParameters, db: DBSession):
    return await SpoolmanService(db).create_filament(data)


@router.patch("/filament/{filament_id}", response_model=schemas.Filament, response_model_exclude_none=True)
async def update_filament(filament_id: int, data: schemas.FilamentParameters, db: DBSession):
    return await SpoolmanService(db).update_filament(filament_id, data)


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
