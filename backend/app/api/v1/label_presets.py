import json
from datetime import datetime
from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import delete, func, select
from sqlalchemy.exc import IntegrityError

from app.api.deps import DBSession, PrincipalDep
from app.core.security import Principal
from app.models import LabelPreset, User
from app.models.label_preset import (
    LABEL_PRESET_NAME_MAX_LENGTH,
    label_preset_name_key,
    normalize_label_preset_name,
)

router = APIRouter(prefix="/me/label-presets", tags=["me"])

LabelPresetType = Literal["spool", "filament", "sheet"]
MAX_PRESETS_PER_TYPE = 100
MAX_PRESET_DATA_BYTES = 128 * 1024


class LabelPresetInput(BaseModel):
    name: str = Field(min_length=1, max_length=LABEL_PRESET_NAME_MAX_LENGTH)
    data: dict[str, Any]

    @field_validator("name")
    @classmethod
    def normalize_name(cls, value: str) -> str:
        return normalize_label_preset_name(value)


class LabelPresetUpsertInput(LabelPresetInput):
    previous_name: str | None = Field(
        default=None,
        min_length=1,
        max_length=LABEL_PRESET_NAME_MAX_LENGTH,
    )

    @field_validator("previous_name")
    @classmethod
    def normalize_previous_name(cls, value: str | None) -> str | None:
        if value is None:
            return None
        return normalize_label_preset_name(value)


class LabelPresetMigrationInput(LabelPresetInput):
    preset_type: LabelPresetType


class LabelPresetMigrationRequest(BaseModel):
    presets: list[LabelPresetMigrationInput] = Field(
        max_length=MAX_PRESETS_PER_TYPE * 3
    )


class LabelPresetResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    preset_type: LabelPresetType
    name: str
    data: dict[str, Any]
    created_at: datetime
    updated_at: datetime


def _require_user_id(principal: Principal) -> int:
    if principal.user_id is None:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={
                "code": "forbidden",
                "message": "Label presets require a user account",
            },
        )
    return principal.user_id


def _validate_presets(
    presets: list[LabelPresetInput], *, reject_duplicates: bool = True
) -> None:
    if len(presets) > MAX_PRESETS_PER_TYPE:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail={
                "code": "validation_error",
                "message": f"At most {MAX_PRESETS_PER_TYPE} presets are allowed per type",
            },
        )
    names: set[str] = set()
    for preset in presets:
        if reject_duplicates and preset.name in names:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail={
                    "code": "validation_error",
                    "message": f"Duplicate preset name: {preset.name}",
                },
            )
        names.add(preset.name)
        try:
            encoded_data = json.dumps(
                preset.data,
                separators=(",", ":"),
                allow_nan=False,
            ).encode("utf-8")
        except (TypeError, ValueError) as exc:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail={
                    "code": "validation_error",
                    "message": f"Preset data is not valid JSON: {preset.name}",
                },
            ) from exc
        if len(encoded_data) > MAX_PRESET_DATA_BYTES:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail={
                    "code": "validation_error",
                    "message": f"Preset data is too large: {preset.name}",
                },
            )


async def _lock_user_presets(db: DBSession, user_id: int) -> None:
    """Serialize preset mutations for one user on databases that support row locks."""
    await db.execute(select(User.id).where(User.id == user_id).with_for_update())


async def _commit_presets(db: DBSession) -> None:
    try:
        await db.commit()
    except IntegrityError as exc:
        await db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "code": "preset_conflict",
                "message": "Label presets changed concurrently or contain conflicting names",
            },
        ) from exc


async def _list_presets(
    db: DBSession,
    user_id: int,
    preset_type: LabelPresetType | None = None,
) -> list[LabelPreset]:
    query = select(LabelPreset).where(LabelPreset.user_id == user_id)
    if preset_type is not None:
        query = query.where(LabelPreset.preset_type == preset_type)
    result = await db.execute(
        query.order_by(
            LabelPreset.preset_type,
            func.lower(LabelPreset.name),
            LabelPreset.name_key,
        )
    )
    return list(result.scalars().all())


@router.get("", response_model=list[LabelPresetResponse])
async def list_label_presets(
    db: DBSession,
    principal: PrincipalDep,
    preset_type: LabelPresetType | None = Query(None),
):
    return await _list_presets(db, _require_user_id(principal), preset_type)


@router.put("/{preset_type}/item", response_model=LabelPresetResponse)
async def upsert_label_preset(
    preset_type: LabelPresetType,
    body: LabelPresetUpsertInput,
    db: DBSession,
    principal: PrincipalDep,
):
    """Create or update one named preset without replacing its siblings."""
    user_id = _require_user_id(principal)
    _validate_presets([body])
    await _lock_user_presets(db, user_id)

    name_key = label_preset_name_key(body.name)
    lookup_name_keys = {name_key}
    if body.previous_name is not None:
        lookup_name_keys.add(label_preset_name_key(body.previous_name))
    result = await db.execute(
        select(LabelPreset).where(
            LabelPreset.user_id == user_id,
            LabelPreset.preset_type == preset_type,
            LabelPreset.name_key.in_(lookup_name_keys),
        )
    )
    matching_presets = {
        preset.name_key: preset for preset in result.scalars().all()
    }
    preset = matching_presets.get(name_key)
    previous_preset = (
        matching_presets.get(label_preset_name_key(body.previous_name))
        if body.previous_name is not None
        else None
    )
    is_rename = body.previous_name is not None and body.previous_name != body.name
    if is_rename and previous_preset is None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "code": "preset_conflict",
                "message": "The preset being renamed no longer exists",
            },
        )
    if previous_preset is not None and previous_preset is not preset:
        if preset is not None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail={
                    "code": "preset_conflict",
                    "message": f"A preset named {body.name} already exists",
                },
            )
        preset = previous_preset
        preset.name = body.name
        preset.name_key = name_key
    if preset is None:
        count = await db.scalar(
            select(func.count())
            .select_from(LabelPreset)
            .where(
                LabelPreset.user_id == user_id,
                LabelPreset.preset_type == preset_type,
            )
        )
        if (count or 0) >= MAX_PRESETS_PER_TYPE:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail={
                    "code": "validation_error",
                    "message": f"At most {MAX_PRESETS_PER_TYPE} presets are allowed per type",
                },
            )
        preset = LabelPreset(
            user_id=user_id,
            preset_type=preset_type,
            name=body.name,
            name_key=name_key,
            data=body.data,
        )
        db.add(preset)
    else:
        preset.data = body.data

    await _commit_presets(db)
    await db.refresh(preset)
    return preset


@router.delete("/{preset_type}/item", status_code=status.HTTP_204_NO_CONTENT)
async def delete_label_preset(
    preset_type: LabelPresetType,
    db: DBSession,
    principal: PrincipalDep,
    name: str = Query(min_length=1, max_length=LABEL_PRESET_NAME_MAX_LENGTH),
):
    """Delete one named preset without replacing its siblings."""
    user_id = _require_user_id(principal)
    try:
        normalized_name = normalize_label_preset_name(name)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail={
                "code": "validation_error",
                "message": str(exc),
            },
        ) from exc
    await _lock_user_presets(db, user_id)
    name_key = label_preset_name_key(normalized_name)
    await db.execute(
        delete(LabelPreset).where(
            LabelPreset.user_id == user_id,
            LabelPreset.preset_type == preset_type,
            LabelPreset.name_key == name_key,
        )
    )
    await _commit_presets(db)


@router.post("/migrate", response_model=list[LabelPresetResponse])
async def migrate_label_presets(
    body: LabelPresetMigrationRequest,
    db: DBSession,
    principal: PrincipalDep,
):
    """Import browser presets once without replacing database-owned values."""
    user_id = _require_user_id(principal)
    grouped: dict[str, list[LabelPresetMigrationInput]] = {}
    for preset in body.presets:
        grouped.setdefault(preset.preset_type, []).append(preset)
    for presets in grouped.values():
        _validate_presets(presets, reject_duplicates=False)

    await _lock_user_presets(db, user_id)
    existing_result = await db.execute(
        select(LabelPreset.preset_type, LabelPreset.name_key).where(
            LabelPreset.user_id == user_id
        )
    )
    existing = set(existing_result.all())
    counts: dict[str, int] = {}
    for preset_type, _name_key in existing:
        counts[preset_type] = counts.get(preset_type, 0) + 1
    for preset in body.presets:
        name_key = label_preset_name_key(preset.name)
        key = (preset.preset_type, name_key)
        if key in existing:
            continue
        if counts.get(preset.preset_type, 0) >= MAX_PRESETS_PER_TYPE:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail={
                    "code": "validation_error",
                    "message": f"At most {MAX_PRESETS_PER_TYPE} presets are allowed per type",
                },
            )
        db.add(
            LabelPreset(
                user_id=user_id,
                preset_type=preset.preset_type,
                name=preset.name,
                name_key=name_key,
                data=preset.data,
            )
        )
        existing.add(key)
        counts[preset.preset_type] = counts.get(preset.preset_type, 0) + 1

    await _commit_presets(db)
    return await _list_presets(db, user_id)
