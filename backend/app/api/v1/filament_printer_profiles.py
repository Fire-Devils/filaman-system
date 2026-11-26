"""CRUD für Druckprofile pro Filament und Drucker (filament_printer_profiles)."""

from datetime import datetime
from typing import Any

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select

from app.api.deps import DBSession, PrincipalDep, RequirePermission
from app.models import Filament, FilamentPrinterProfile, Printer
from app.services.print_profile_validation import find_implausible_values

router_filament_profiles = APIRouter()

_FILAMENT_UPDATE = RequirePermission("filaments:update")


class PrintProfileFields(BaseModel):
    is_default_for_printer: bool = False

    nozzle_diameter_mm: float | None = None
    extruder_type: str | None = Field(None, max_length=50)

    nozzle_temp_c: int | None = None
    bed_temp_c: int | None = None
    chamber_temp_c: int | None = None

    print_speed_mm_s: int | None = None
    travel_speed_mm_s: int | None = None
    first_layer_speed_mm_s: int | None = None
    max_volumetric_flow_mm3_s: float | None = None

    flowrate_percent: int | None = None
    extrusion_multiplier: float | None = None
    pressure_advance_k: float | None = None
    linear_advance_k: float | None = None

    retraction_mm: float | None = None
    retraction_speed_mm_s: int | None = None
    deretraction_speed_mm_s: int | None = None
    retraction_extra_prime_mm3: float | None = None

    fan_percent_min: int | None = None
    fan_percent_max: int | None = None
    fan_first_layer_percent: int | None = None

    z_hop_mm: float | None = None
    z_hop_only_when_retracting: bool | None = None
    bridge_flow_percent: int | None = None
    bridge_fan_percent: int | None = None

    build_plate: str | None = Field(None, max_length=100)

    material_notes: str | None = Field(None, max_length=2000)


class PrintProfileCreate(PrintProfileFields):
    printer_id: int
    profile_name: str = Field(..., min_length=1, max_length=255)


class PrintProfileUpdate(PrintProfileFields):
    """Teilweise Änderung: nur gesendete Felder werden übernommen."""

    printer_id: int | None = None
    profile_name: str | None = Field(None, min_length=1, max_length=255)
    is_default_for_printer: bool | None = None


class PrintProfileResponse(PrintProfileFields):
    model_config = ConfigDict(from_attributes=True)

    id: int
    filament_id: int
    printer_id: int
    profile_name: str
    printer_name: str | None = None
    printer_manufacturer: str | None = None
    printer_model: str | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None


def _not_found(message: str) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_404_NOT_FOUND,
        detail={"code": "not_found", "message": message},
    )


def _check_plausible(values: dict[str, Any]) -> None:
    problems = find_implausible_values(values)
    if problems:
        first = problems[0]
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail={
                "code": "implausible_value",
                "message": (
                    f"{first['field']} must be between {first['min']} and {first['max']}"
                ),
                "field": first["field"],
                "min": first["min"],
                "max": first["max"],
                "problems": problems,
            },
        )


async def _require_filament(db: DBSession, filament_id: int) -> None:
    found = await db.scalar(select(Filament.id).where(Filament.id == filament_id))
    if found is None:
        raise _not_found("Filament not found")


async def _require_printer(db: DBSession, printer_id: int) -> Printer:
    printer = await db.scalar(
        select(Printer).where(Printer.id == printer_id, Printer.deleted_at.is_(None))
    )
    if printer is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"code": "validation_error", "message": "Printer not found"},
        )
    return printer


async def _get_profile(
    db: DBSession, filament_id: int, profile_id: int
) -> FilamentPrinterProfile:
    profile = await db.scalar(
        select(FilamentPrinterProfile).where(
            FilamentPrinterProfile.id == profile_id,
            FilamentPrinterProfile.filament_id == filament_id,
        )
    )
    if profile is None:
        raise _not_found("Printer profile not found")
    return profile


async def _to_response(db: DBSession, profile: FilamentPrinterProfile) -> PrintProfileResponse:
    printer = await db.get(Printer, profile.printer_id)
    out = PrintProfileResponse.model_validate(profile)
    if printer is not None:
        out.printer_name = printer.name
        out.printer_manufacturer = printer.printer_manufacturer
        out.printer_model = printer.printer_model
    return out


async def _clear_other_defaults(
    db: DBSession, filament_id: int, printer_id: int, keep_id: int | None
) -> None:
    rows = await db.scalars(
        select(FilamentPrinterProfile).where(
            FilamentPrinterProfile.filament_id == filament_id,
            FilamentPrinterProfile.printer_id == printer_id,
            FilamentPrinterProfile.is_default_for_printer.is_(True),
        )
    )
    for row in rows:
        if row.id != keep_id:
            row.is_default_for_printer = False


@router_filament_profiles.get(
    "/{filament_id}/printer-profiles", response_model=list[PrintProfileResponse]
)
async def list_printer_profiles(
    filament_id: int, db: DBSession, principal: PrincipalDep
):
    await _require_filament(db, filament_id)
    rows = (
        await db.scalars(
            select(FilamentPrinterProfile)
            .where(FilamentPrinterProfile.filament_id == filament_id)
            .order_by(FilamentPrinterProfile.printer_id, FilamentPrinterProfile.id)
        )
    ).all()
    return [await _to_response(db, row) for row in rows]


@router_filament_profiles.post(
    "/{filament_id}/printer-profiles",
    response_model=PrintProfileResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_printer_profile(
    filament_id: int,
    data: PrintProfileCreate,
    db: DBSession,
    principal=_FILAMENT_UPDATE,
):
    await _require_filament(db, filament_id)
    await _require_printer(db, data.printer_id)
    values = data.model_dump()
    _check_plausible(values)

    profile = FilamentPrinterProfile(filament_id=filament_id, **values)
    db.add(profile)
    await db.flush()
    if profile.is_default_for_printer:
        await _clear_other_defaults(db, filament_id, profile.printer_id, profile.id)
    await db.commit()
    await db.refresh(profile)
    return await _to_response(db, profile)


@router_filament_profiles.put(
    "/{filament_id}/printer-profiles/{profile_id}",
    response_model=PrintProfileResponse,
)
async def update_printer_profile(
    filament_id: int,
    profile_id: int,
    data: PrintProfileUpdate,
    db: DBSession,
    principal=_FILAMENT_UPDATE,
):
    profile = await _get_profile(db, filament_id, profile_id)
    updates = data.model_dump(exclude_unset=True)
    # Pflichtfelder dürfen nicht auf null gesetzt werden.
    for required in ("printer_id", "profile_name", "is_default_for_printer"):
        if required in updates and updates[required] is None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail={
                    "code": "validation_error",
                    "message": f"{required} must not be null",
                },
            )
    if "printer_id" in updates:
        await _require_printer(db, updates["printer_id"])

    merged = {
        field: getattr(profile, field)
        for field in PrintProfileFields.model_fields
    }
    merged.update(updates)
    _check_plausible(merged)

    for key, value in updates.items():
        setattr(profile, key, value)
    if profile.is_default_for_printer:
        await _clear_other_defaults(db, filament_id, profile.printer_id, profile.id)
    await db.commit()
    await db.refresh(profile)
    return await _to_response(db, profile)


@router_filament_profiles.delete(
    "/{filament_id}/printer-profiles/{profile_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def delete_printer_profile(
    filament_id: int,
    profile_id: int,
    db: DBSession,
    principal=_FILAMENT_UPDATE,
):
    profile = await _get_profile(db, filament_id, profile_id)
    await db.delete(profile)
    await db.commit()
