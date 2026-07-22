from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.cache import response_cache
from app.core.database import get_db
from app.api.deps import RequirePermission, PrincipalDep
from app.models.system_extra_field import SystemExtraField
from app.api.v1.schemas_system_extra_field import (
    SystemExtraFieldCreate,
    SystemExtraFieldResponse,
    SystemExtraFieldUpdate,
)

router = APIRouter()

# Cache TTL in seconds (5 minutes - extra fields rarely change)
_EXTRA_FIELDS_CACHE_TTL = 300


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
        SystemExtraField.key == field.key,
    )
    existing = await db.execute(query)
    if existing.scalar_one_or_none():
        raise HTTPException(
            status_code=400,
            detail="Field with this key already exists for this target type",
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
    query = select(SystemExtraField).where(SystemExtraField.id == field_id)
    result = await db.execute(query)
    field = result.scalar_one_or_none()
    if not field:
        raise HTTPException(status_code=404, detail="Field not found")

    if field.source:
        raise HTTPException(
            status_code=403,
            detail=f"Cannot edit plugin-managed field (source: {field.source}). Plugin fields are read-only.",
        )

    # Apply updates (only non-None values)
    update_dict = update_data.model_dump(exclude_unset=True)
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
    query = select(SystemExtraField).where(SystemExtraField.id == field_id)
    result = await db.execute(query)
    field = result.scalar_one_or_none()
    if not field:
        raise HTTPException(status_code=404, detail="Field not found")

    if field.source:
        raise HTTPException(
            status_code=403,
            detail=f"Cannot delete plugin-managed field (source: {field.source}). Uninstall the plugin to remove its fields.",
        )

    # Store for cache invalidation before deletion
    target_type = field.target_type
    source = field.source

    await db.delete(field)
    await db.commit()

    # Invalidate cache
    _invalidate_extra_fields_cache(target_type, source)
