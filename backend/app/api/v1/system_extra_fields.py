from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import PrincipalDep, RequirePermission
from app.api.v1.schemas_system_extra_field import (
    SystemExtraFieldCreate,
    SystemExtraFieldResponse,
    SystemExtraFieldUpdate,
    validate_field_type_config,
)
from app.core.cache import response_cache
from app.core.database import get_db
from app.models.system_extra_field import SystemExtraField
from app.services.system_extra_field_compatibility import (
    find_incompatible_existing_values,
    find_overlapping_definition,
)

router = APIRouter()

# Cache TTL in seconds (5 minutes - extra fields rarely change)
_EXTRA_FIELDS_CACHE_TTL = 300
_PLUGIN_MANAGED_FIELD_ERRORS = {
    "edit": (
        "Cannot edit plugin-managed field (source: {source}). "
        "Plugin fields are read-only."
    ),
    "delete": (
        "Cannot delete plugin-managed field (source: {source}). "
        "Uninstall the plugin to remove its fields."
    ),
}


def _invalidate_extra_fields_cache(
    target_type: str | None = None, source: str | None = None
) -> None:
    """Invalidate extra fields cache entries.

    If target_type/source provided, invalidates specific entries.
    Otherwise invalidates all extra_fields cache entries.
    """
    if target_type:
        response_cache.delete(f"extra_fields:{target_type}:{source or 'all'}")
        response_cache.delete(f"extra_fields:{target_type}:all")
    # Always invalidate the "all" queries
    response_cache.delete("extra_fields:all:all")


def _raise_incompatible_values(
    *,
    target_type: str,
    key: str,
    field_type: str,
    incompatible_count: int,
    sample_record_ids: list[int],
) -> None:
    if not incompatible_count:
        return
    raise HTTPException(
        status_code=status.HTTP_409_CONFLICT,
        detail={
            "code": "incompatible_existing_values",
            "message": (
                f"Cannot define {target_type}.{key}: {incompatible_count} existing "
                f"record(s) are incompatible with field type {field_type!r} — their "
                "retained value or their record-local definition conflicts. Reuse a "
                "compatible definition, convert those values, or clear them first."
            ),
            "target_type": target_type,
            "key": key,
            "field_type": field_type,
            "incompatible_count": incompatible_count,
            "sample_record_ids": sample_record_ids,
        },
    )


async def _get_user_managed_field(
    db: AsyncSession,
    field_id: int,
    operation: Literal["edit", "delete"],
) -> SystemExtraField:
    """Load an editable field while preserving operation-specific API errors."""
    query = select(SystemExtraField).where(SystemExtraField.id == field_id)
    result = await db.execute(query)
    field = result.scalar_one_or_none()
    if not field:
        raise HTTPException(status_code=404, detail="Field not found")
    if field.source:
        raise HTTPException(
            status_code=403,
            detail=_PLUGIN_MANAGED_FIELD_ERRORS[operation].format(source=field.source),
        )
    return field


@router.get("", response_model=list[SystemExtraFieldResponse])
async def get_system_extra_fields(
    principal: PrincipalDep,
    target_type: str | None = None,
    source: str | None = None,
    db: AsyncSession = Depends(get_db),
):
    # Build cache key based on query parameters
    cache_key = f"extra_fields:{target_type or 'all'}:{source or 'all'}"
    cached = response_cache.get(cache_key)
    if cached is not None:
        return cached

    query = select(SystemExtraField)
    if target_type:
        query = query.where(SystemExtraField.target_type == target_type)
    if source:
        query = query.where(SystemExtraField.source == source)
    result = await db.execute(query)
    items = result.scalars().all()

    # Serialize and cache (ORM objects can't be pickled after session closes)
    serialized = [SystemExtraFieldResponse.model_validate(f) for f in items]
    response_cache.set(cache_key, serialized, ttl=_EXTRA_FIELDS_CACHE_TTL)
    return serialized


@router.post(
    "",
    response_model=SystemExtraFieldResponse,
    dependencies=[RequirePermission("admin:system")],
)
async def create_system_extra_field(
    field: SystemExtraFieldCreate,
    db: AsyncSession = Depends(get_db),
):
    query = select(SystemExtraField).where(
        SystemExtraField.target_type == field.target_type,
    )
    existing = await db.execute(query)
    overlapping = find_overlapping_definition(
        existing.scalars(),
        field.target_type,
        field.key,
    )
    if overlapping:
        if overlapping.key == field.key:
            detail = "Field with this key already exists for this target type"
        else:
            detail = (
                "Field key overlaps an existing parent or child path "
                f"({overlapping.key!r})"
            )
        raise HTTPException(
            status_code=400,
            detail=detail,
        )

    incompatible_count, sample_record_ids = await find_incompatible_existing_values(
        db,
        target_type=field.target_type,
        key=field.key,
        field_type=field.field_type,
        options=field.options,
        config=field.config,
    )
    _raise_incompatible_values(
        target_type=field.target_type,
        key=field.key,
        field_type=field.field_type,
        incompatible_count=incompatible_count,
        sample_record_ids=sample_record_ids,
    )

    new_field = SystemExtraField(**field.model_dump())
    db.add(new_field)
    await db.commit()
    await db.refresh(new_field)

    # Invalidate cache for this target_type
    _invalidate_extra_fields_cache(new_field.target_type, new_field.source)
    return new_field


@router.put(
    "/{field_id}",
    response_model=SystemExtraFieldResponse,
    dependencies=[RequirePermission("admin:system")],
)
async def update_system_extra_field(
    field_id: int,
    update_data: SystemExtraFieldUpdate,
    db: AsyncSession = Depends(get_db),
):
    """Update a user-created extra field. Plugin-managed fields cannot be edited."""
    field = await _get_user_managed_field(db, field_id, "edit")

    # Apply updates (only non-None values)
    update_dict = update_data.model_dump(exclude_unset=True)

    effective_field_type = update_dict.get("field_type", field.field_type)
    effective_options = update_dict.get("options", field.options)
    effective_config = update_dict.get("config", field.config)
    try:
        validate_field_type_config(
            effective_field_type,
            effective_options,
            effective_config,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    if {"field_type", "options", "config"}.intersection(update_dict):
        incompatible_count, sample_record_ids = await find_incompatible_existing_values(
            db,
            target_type=field.target_type,
            key=field.key,
            field_type=effective_field_type,
            options=effective_options,
            config=effective_config,
        )
        _raise_incompatible_values(
            target_type=field.target_type,
            key=field.key,
            field_type=effective_field_type,
            incompatible_count=incompatible_count,
            sample_record_ids=sample_record_ids,
        )

    for key, value in update_dict.items():
        setattr(field, key, value)

    await db.commit()
    await db.refresh(field)

    # Invalidate cache for this target_type
    _invalidate_extra_fields_cache(field.target_type, field.source)
    return field


@router.delete(
    "/{field_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[RequirePermission("admin:system")],
)
async def delete_system_extra_field(
    field_id: int,
    db: AsyncSession = Depends(get_db),
):
    field = await _get_user_managed_field(db, field_id, "delete")

    # Store for cache invalidation before deletion
    target_type = field.target_type
    source = field.source

    await db.delete(field)
    await db.commit()

    # Invalidate cache
    _invalidate_extra_fields_cache(target_type, source)
