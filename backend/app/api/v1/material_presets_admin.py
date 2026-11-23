from typing import Self

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, ConfigDict, Field, FiniteFloat, model_validator
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.api.deps import DBSession, RequirePermission
from app.core.event_bus import event_bus
from app.models import AppSettings, Filament, Manufacturer, MaterialPreset
from app.services.material_presets import (
    DEFAULT_MATERIAL_PRESETS,
    apply_material_defaults,
    invalidate_preset_cache,
    match_preset,
)

router = APIRouter(prefix="/admin/material-presets", tags=["admin"])

_PERMISSION = "admin:users_manage"


class _PresetValues(BaseModel):
    extruder_temp_min_c: FiniteFloat | None = Field(None, gt=0)
    extruder_temp_max_c: FiniteFloat | None = Field(None, gt=0)
    bed_temp_min_c: FiniteFloat | None = Field(None, gt=0)
    bed_temp_max_c: FiniteFloat | None = Field(None, gt=0)
    flow_ratio: FiniteFloat | None = Field(None, ge=0.5, le=1.5)
    drying_temp_c: FiniteFloat | None = Field(None, gt=0)
    drying_time_hours: FiniteFloat | None = Field(None, gt=0)
    drying_interval_days: int | None = Field(None, gt=0)
    density_g_cm3: FiniteFloat | None = Field(None, gt=0)

    @model_validator(mode="after")
    def _check_ranges(self) -> Self:
        for lo, hi in (
            ("extruder_temp_min_c", "extruder_temp_max_c"),
            ("bed_temp_min_c", "bed_temp_max_c"),
        ):
            low, high = getattr(self, lo), getattr(self, hi)
            if low is not None and high is not None and low > high:
                raise ValueError(f"{lo} must not exceed {hi}")
        return self


class MaterialPresetCreate(_PresetValues):
    material_type: str = Field(..., min_length=1, max_length=50)


class MaterialPresetUpdate(_PresetValues):
    material_type: str | None = Field(None, min_length=1, max_length=50)


class MaterialPresetResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    material_type: str
    extruder_temp_min_c: float | None = None
    extruder_temp_max_c: float | None = None
    bed_temp_min_c: float | None = None
    bed_temp_max_c: float | None = None
    flow_ratio: float | None = None
    drying_temp_c: float | None = None
    drying_time_hours: float | None = None
    drying_interval_days: int | None = None
    density_g_cm3: float | None = None


class ApplyResult(BaseModel):
    updated_filaments: int
    updated_fields: int


def _clean_type(value: str) -> str:
    value = value.strip()
    if not value:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "material_type is required")
    return value


async def _all(db) -> list[MaterialPreset]:
    result = await db.execute(select(MaterialPreset).order_by(MaterialPreset.material_type))
    return list(result.scalars().all())


@router.get("", response_model=list[MaterialPresetResponse])
async def list_material_presets(db: DBSession, principal=RequirePermission(_PERMISSION)):
    return await _all(db)


@router.post("", response_model=MaterialPresetResponse, status_code=status.HTTP_201_CREATED)
async def create_material_preset(
    data: MaterialPresetCreate,
    db: DBSession,
    principal=RequirePermission(_PERMISSION),
):
    values = data.model_dump()
    values["material_type"] = _clean_type(data.material_type)
    existing = await db.execute(
        select(MaterialPreset).where(MaterialPreset.material_type == values["material_type"])
    )
    if existing.scalar_one_or_none() is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, "Preset for this material already exists")
    preset = MaterialPreset(**values)
    db.add(preset)
    await db.commit()
    await db.refresh(preset)
    invalidate_preset_cache()
    return preset


@router.patch("/{preset_id}", response_model=MaterialPresetResponse)
async def update_material_preset(
    preset_id: int,
    data: MaterialPresetUpdate,
    db: DBSession,
    principal=RequirePermission(_PERMISSION),
):
    preset = await db.get(MaterialPreset, preset_id)
    if preset is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Preset not found")
    updates = data.model_dump(exclude_unset=True)
    if updates.get("material_type") is None:
        updates.pop("material_type", None)
    else:
        updates["material_type"] = _clean_type(updates["material_type"])
    merged = {k: getattr(preset, k) for k in _PresetValues.model_fields} | {
        k: v for k, v in updates.items() if k != "material_type"
    }
    try:
        # Validate the merged ranges, not only the supplied half.
        _PresetValues.model_validate(merged)
    except ValueError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(exc)) from exc
    for key, value in updates.items():
        setattr(preset, key, value)
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, "Preset for this material already exists")
    await db.refresh(preset)
    invalidate_preset_cache()
    return preset


@router.delete("/{preset_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_material_preset(
    preset_id: int,
    db: DBSession,
    principal=RequirePermission(_PERMISSION),
):
    preset = await db.get(MaterialPreset, preset_id)
    if preset is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Preset not found")
    await db.delete(preset)
    await db.commit()
    invalidate_preset_cache()


@router.post("/reset", response_model=list[MaterialPresetResponse])
async def reset_material_presets(db: DBSession, principal=RequirePermission(_PERMISSION)):
    """Restore the shipped default list (replaces every existing preset)."""
    for preset in await _all(db):
        await db.delete(preset)
    await db.flush()
    for row in DEFAULT_MATERIAL_PRESETS:
        db.add(MaterialPreset(**row))
    await db.commit()
    invalidate_preset_cache()
    return await _all(db)


@router.post("/apply-to-filaments", response_model=ApplyResult)
async def apply_presets_to_filaments(db: DBSession, principal=RequirePermission(_PERMISSION)):
    """Fill empty fields of ALL filaments from the presets; set values stay."""
    presets = await _all(db)
    settings_row = (
        await db.execute(select(AppSettings).where(AppSettings.id == 1))
    ).scalar_one_or_none()
    manufacturers = {
        m.id: m for m in (await db.execute(select(Manufacturer))).scalars().all()
    }
    updated_filaments = 0
    updated_fields = 0
    for filament in (await db.execute(select(Filament))).scalars().all():
        preset = match_preset(presets, filament.material_type, filament.material_subgroup)
        changed = apply_material_defaults(
            filament, preset, settings_row, manufacturers.get(filament.manufacturer_id)
        )
        if changed:
            updated_filaments += 1
            updated_fields += changed
    await db.commit()
    if updated_filaments:
        await event_bus.publish({"event": "filaments_changed"})
    return ApplyResult(updated_filaments=updated_filaments, updated_fields=updated_fields)
