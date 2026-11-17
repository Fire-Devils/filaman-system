"""AMS tray codes are material-specific. Drop them when the material changes."""

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.printer_params import FilamentPrinterParam, SpoolPrinterParam
from app.models.spool import Spool

_BAMBU_IDX = "bambu_idx"


async def clear_bambu_idx_for_filament(db: AsyncSession, filament_id: int) -> int:
    """Delete filament- and spool-level ``bambu_idx`` rows for one filament.

    Other printer params (slicer setting id, flow, K) stay. Returns the number
    of rows removed.
    """
    spool_ids = select(Spool.id).where(Spool.filament_id == filament_id)
    filament_rows = await db.execute(
        delete(FilamentPrinterParam).where(
            FilamentPrinterParam.filament_id == filament_id,
            FilamentPrinterParam.param_key == _BAMBU_IDX,
        )
    )
    spool_rows = await db.execute(
        delete(SpoolPrinterParam).where(
            SpoolPrinterParam.spool_id.in_(spool_ids),
            SpoolPrinterParam.param_key == _BAMBU_IDX,
        )
    )
    return int(filament_rows.rowcount or 0) + int(spool_rows.rowcount or 0)
