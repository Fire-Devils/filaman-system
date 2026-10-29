from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import PrincipalDep, RequirePermission
from app.api.v1.schemas_printer_params import (
    FilamentPrinterParamResponse,
    PrinterParamBulkRequest,
    SpoolPrinterParamResponse,
)
from app.core.database import get_db
from app.models import Printer
from app.models.printer_params import FilamentPrinterParam, SpoolPrinterParam
from app.models.system_extra_field import SystemExtraField
from app.plugins.manager import plugin_manager

router_filament_params = APIRouter()
router_spool_params = APIRouter()

# bambu_idx holds generic AMS codes (SUN20012). Cloud presets (PFUS…) belong in
# bambu_slicer_setting_id via the driver's set_*_profile actions.
def _reject_cloud_preset_in_bambu_idx(param_key: str, param_value: str | None) -> None:
    if param_key != "bambu_idx" or not param_value:
        return
    value = param_value.strip()
    if value.startswith("PFUS"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "code": "invalid_param_value",
                "message": (
                    "bambu_idx must be a generic AMS code (e.g. SUN20012), not a cloud "
                    "preset. Use the Slicer Profile picker."
                ),
            },
        )


async def _get_valid_param_keys(db: AsyncSession, printer_id: int, target_type: str) -> set[str] | None:
    """Accept declared driver keys and previously registered keys.

    Returns None if no definitions exist (validation skipped).
    Returns a set of valid keys if definitions exist.
    """
    result = await db.execute(
        select(Printer.driver_key).where(Printer.id == printer_id)
    )
    row = result.one_or_none()
    if not row or not row[0]:
        return None  # No driver, skip validation

    driver_key = row[0]
    result = await db.execute(
        select(SystemExtraField.key).where(
            SystemExtraField.source == driver_key,
            SystemExtraField.target_type == target_type,
        )
    )
    keys = {r[0] for r in result.all()}
    if not keys:
        return None  # Preserve validation bypass when no definitions exist.
    # Shared keys can belong to a different driver in the global registry.
    keys.update(field["key"] for field in plugin_manager.get_printer_parameter_fields(driver_key, target_type))
    return keys

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
    dependencies=[RequirePermission("filaments:update")],
)
async def upsert_filament_printer_params(
    filament_id: int,
    printer_id: int,
    body: PrinterParamBulkRequest,
    db: AsyncSession = Depends(get_db),
):
    """Bulk upsert printer params for a filament + printer combination."""
    # Validate param_keys against driver's SystemExtraField definitions
    valid_keys = await _get_valid_param_keys(db, printer_id, "filament_printer_param")
    if valid_keys is not None:
        invalid = [item.param_key for item in body.params if item.param_key not in valid_keys]
        if invalid:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail={
                    "code": "invalid_param_keys",
                    "message": f"Unknown param_key(s): {', '.join(invalid)}",
                    "valid_keys": sorted(valid_keys),
                },
            )

    results = []
    for item in body.params:
        _reject_cloud_preset_in_bambu_idx(item.param_key, item.param_value)
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
    dependencies=[RequirePermission("filaments:update")],
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
    dependencies=[RequirePermission("spools:update")],
)
async def upsert_spool_printer_params(
    spool_id: int,
    printer_id: int,
    body: PrinterParamBulkRequest,
    db: AsyncSession = Depends(get_db),
):
    """Bulk upsert printer params for a spool + printer combination."""
    # Validate param_keys against driver's SystemExtraField definitions
    valid_keys = await _get_valid_param_keys(db, printer_id, "spool_printer_param")
    if valid_keys is not None:
        invalid = [item.param_key for item in body.params if item.param_key not in valid_keys]
        if invalid:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail={
                    "code": "invalid_param_keys",
                    "message": f"Unknown param_key(s): {', '.join(invalid)}",
                    "valid_keys": sorted(valid_keys),
                },
            )

    results = []
    for item in body.params:
        _reject_cloud_preset_in_bambu_idx(item.param_key, item.param_value)
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
    dependencies=[RequirePermission("spools:update")],
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
