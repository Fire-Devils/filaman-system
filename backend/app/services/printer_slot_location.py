"""Resolve printer-slot locations and build the payload for slot assignment.

Driver plugins create one Location per printer slot when they assign a spool,
tagging it with a machine-readable identifier
(``<plugin>_<printer_id>_<ams_id>_<tray_id>``) plus ``managed_by`` /
``printer_id`` in ``custom_fields``. That tag is the link between a Location
and the slot it stands for, and lets a plain "move spool to location" trigger
the same driver action as the printer/slot widget on the spool detail page.
"""

import re
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.models import Filament, FilamentColor, Location, Spool
from app.plugins.manager import plugin_manager

# "bambuddy_3_0_1" -> printer 3, AMS 0, tray 1. The prefix is matched greedily
# so plugin keys containing underscores still resolve; the three trailing
# numeric groups are what matters.
_SLOT_IDENTIFIER_RE = re.compile(r"^(?P<prefix>.+)_(?P<printer>\d+)_(?P<ams>\d+)_(?P<tray>\d+)$")

# Frontend parity: handleAssignSpoolToTray() in spools/[id]/index.astro
_DEFAULT_TRAY_INFO_IDX = "GFL99"
_DEFAULT_NOZZLE_TEMP_MIN = 190
_DEFAULT_NOZZLE_TEMP_MAX = 230
_DEFAULT_MATERIAL_TYPE = "PLA"
_DEFAULT_COLOR = "FFFFFF"


@dataclass(frozen=True)
class SlotLocationRef:
    """The printer slot a Location stands for."""

    printer_id: int
    ams_id: int
    tray_id: int


async def resolve_slot_location(
    db: AsyncSession, location_id: int | None
) -> SlotLocationRef | None:
    """Return the slot a location represents, or None for a plain location.

    Location.identifier doubles as the RFID tag UUID for user-created
    locations, so a matching identifier alone is not enough: the location must
    also carry the ``managed_by`` marker a driver plugin writes, and its
    ``printer_id`` must agree with the identifier.
    """
    if location_id is None:
        return None

    result = await db.execute(select(Location).where(Location.id == location_id))
    location = result.scalar_one_or_none()
    if location is None or not location.identifier:
        return None

    match = _SLOT_IDENTIFIER_RE.match(location.identifier)
    if not match:
        return None

    custom_fields = location.custom_fields
    if not isinstance(custom_fields, dict):
        return None

    managed_by = custom_fields.get("managed_by")
    if not isinstance(managed_by, str) or not managed_by.endswith("_plugin"):
        return None

    printer_id = int(match.group("printer"))
    if custom_fields.get("printer_id") != printer_id:
        return None

    return SlotLocationRef(
        printer_id=printer_id,
        ams_id=int(match.group("ams")),
        tray_id=int(match.group("tray")),
    )


async def build_slot_filament_data(
    db: AsyncSession, spool_id: int, printer_id: int
) -> dict:
    """Build the filament_data payload for send_filament_to_tray.

    Mirrors handleAssignSpoolToTray() in the frontend: start from the spool's
    material and colour, overlay the printer-specific params, then map the
    bambu_* param keys onto the driver's field names. Re-running the enrichment
    later in execute_driver_action() is idempotent.
    """
    result = await db.execute(
        select(Spool)
        .where(Spool.id == spool_id)
        .options(
            selectinload(Spool.filament)
            .selectinload(Filament.filament_colors)
            .selectinload(FilamentColor.color),
        )
    )
    spool = result.scalar_one_or_none()

    filament = spool.filament if spool else None
    material_type = (filament.material_type if filament else None) or _DEFAULT_MATERIAL_TYPE

    color = _DEFAULT_COLOR
    if filament and filament.filament_colors:
        first_color = filament.filament_colors[0].color
        if first_color and first_color.hex_code:
            color = first_color.hex_code.replace("#", "")[:6]

    filament_data: dict = {
        "tray_info_idx": _DEFAULT_TRAY_INFO_IDX,
        "bambu_idx": "",
        "nozzle_temp_min": _DEFAULT_NOZZLE_TEMP_MIN,
        "nozzle_temp_max": _DEFAULT_NOZZLE_TEMP_MAX,
        "material_type": material_type,
        "color": color,
    }

    filament_data = await plugin_manager.enrich_filament_data(
        spool_id=spool_id,
        printer_id=printer_id,
        filament_data=filament_data,
    )

    # enrich_filament_data() copies param keys verbatim; the mapping onto the
    # driver's field names is what the frontend does on top of it.
    tray_info_idx = filament_data.get("bambu_idx") or filament_data.get("bambu_tray_idx")
    filament_data["tray_info_idx"] = tray_info_idx or _DEFAULT_TRAY_INFO_IDX
    filament_data["nozzle_temp_min"] = _coerce_int(
        filament_data.get("bambu_nozzle_temp_min"), _DEFAULT_NOZZLE_TEMP_MIN
    )
    filament_data["nozzle_temp_max"] = _coerce_int(
        filament_data.get("bambu_nozzle_temp_max"), _DEFAULT_NOZZLE_TEMP_MAX
    )

    return filament_data


def _coerce_int(value, fallback: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return fallback
