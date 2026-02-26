from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select, delete
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.api.deps import PrincipalDep, RequirePermission
from app.models.printer_params import FilamentPrinterParam, SpoolPrinterParam
from app.api.v1.schemas_printer_params import (
    FilamentPrinterParamResponse,
    PrinterParamBulkRequest,
    PrinterParamCreate,
    PrinterParamUpdate,
    SpoolPrinterParamResponse,
)

router_filament_params = APIRouter()
router_spool_params = APIRouter()


# ─── Filament Printer Params ──────────────────────────────────────────────────


@router_filament_params.get(
    "/{filament_id}/printer-params",
    response_model=list[FilamentPrinterParamResponse],
)
async def get_filament_printer_params(
    filament_id: int,
    principal: PrincipalDep,
    printer_id: int | None = None,
    db: AsyncSession = Depends(get_db),
):
    """Get all printer params for a filament, optionally filtered by printer."""
    query = select(FilamentPrinterParam).where(FilamentPrinterParam.filament_id == filament_id)
    if printer_id is not None:
        query = query.where(FilamentPrinterParam.printer_id == printer_id)
    result = await db.execute(query)
    return result.scalars().all()


@router_filament_params.put(
    "/{filament_id}/printer-params/{printer_id}",
    response_model=list[FilamentPrinterParamResponse],
    dependencies=[RequirePermission("filaments:edit")],
)
async def upsert_filament_printer_params(
    filament_id: int,
    printer_id: int,
    body: PrinterParamBulkRequest,
    db: AsyncSession = Depends(get_db),
):
    """Bulk upsert printer params for a filament + printer combination."""
    results = []
    for item in body.params:
        query = select(FilamentPrinterParam).where(
            FilamentPrinterParam.filament_id == filament_id,
            FilamentPrinterParam.printer_id == printer_id,
            FilamentPrinterParam.param_key == item.param_key,
        )
        result = await db.execute(query)
        existing = result.scalar_one_or_none()

        if existing:
            existing.param_value = item.param_value
            results.append(existing)
        else:
            new_param = FilamentPrinterParam(
                filament_id=filament_id,
                printer_id=printer_id,
                param_key=item.param_key,
                param_value=item.param_value,
            )
            db.add(new_param)
            results.append(new_param)

    await db.commit()
    for r in results:
        await db.refresh(r)
    return results


@router_filament_params.delete(
    "/{filament_id}/printer-params/{printer_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[RequirePermission("filaments:edit")],
)
async def delete_filament_printer_params(
    filament_id: int,
    printer_id: int,
    param_key: str | None = None,
    db: AsyncSession = Depends(get_db),
):
    """Delete printer params. If param_key given, delete only that key. Otherwise delete all for printer."""
    query = delete(FilamentPrinterParam).where(
        FilamentPrinterParam.filament_id == filament_id,
        FilamentPrinterParam.printer_id == printer_id,
    )
    if param_key:
        query = query.where(FilamentPrinterParam.param_key == param_key)
    await db.execute(query)
    await db.commit()


# ─── Spool Printer Params ────────────────────────────────────────────────────


@router_spool_params.get(
    "/{spool_id}/printer-params",
    response_model=list[SpoolPrinterParamResponse],
)
async def get_spool_printer_params(
    spool_id: int,
    principal: PrincipalDep,
    printer_id: int | None = None,
    db: AsyncSession = Depends(get_db),
):
    """Get all printer params for a spool, optionally filtered by printer."""
    query = select(SpoolPrinterParam).where(SpoolPrinterParam.spool_id == spool_id)
    if printer_id is not None:
        query = query.where(SpoolPrinterParam.printer_id == printer_id)
    result = await db.execute(query)
    return result.scalars().all()


@router_spool_params.put(
    "/{spool_id}/printer-params/{printer_id}",
    response_model=list[SpoolPrinterParamResponse],
    dependencies=[RequirePermission("spools:edit")],
)
async def upsert_spool_printer_params(
    spool_id: int,
    printer_id: int,
    body: PrinterParamBulkRequest,
    db: AsyncSession = Depends(get_db),
):
    """Bulk upsert printer params for a spool + printer combination."""
    results = []
    for item in body.params:
        query = select(SpoolPrinterParam).where(
            SpoolPrinterParam.spool_id == spool_id,
            SpoolPrinterParam.printer_id == printer_id,
            SpoolPrinterParam.param_key == item.param_key,
        )
        result = await db.execute(query)
        existing = result.scalar_one_or_none()

        if existing:
            existing.param_value = item.param_value
            results.append(existing)
        else:
            new_param = SpoolPrinterParam(
                spool_id=spool_id,
                printer_id=printer_id,
                param_key=item.param_key,
                param_value=item.param_value,
            )
            db.add(new_param)
            results.append(new_param)

    await db.commit()
    for r in results:
        await db.refresh(r)
    return results


@router_spool_params.delete(
    "/{spool_id}/printer-params/{printer_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[RequirePermission("spools:edit")],
)
async def delete_spool_printer_params(
    spool_id: int,
    printer_id: int,
    param_key: str | None = None,
    db: AsyncSession = Depends(get_db),
):
    """Delete printer params. If param_key given, delete only that key. Otherwise delete all for printer."""
    query = delete(SpoolPrinterParam).where(
        SpoolPrinterParam.spool_id == spool_id,
        SpoolPrinterParam.printer_id == printer_id,
    )
    if param_key:
        query = query.where(SpoolPrinterParam.param_key == param_key)
    await db.execute(query)
    await db.commit()
