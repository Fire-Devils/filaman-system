from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession


async def get_next_available_id(db: AsyncSession, Model) -> int:
    """Findet die kleinste positive freie ID (Gap-Filling)."""
    result = await db.execute(select(Model.id).order_by(Model.id))
    existing_ids = set(result.scalars().all())
    i = 1
    while i in existing_ids:
        i += 1
    return i


async def get_next_available_ids(db: AsyncSession, Model, count: int) -> list[int]:
    """Findet die `count` kleinsten freien IDs (Gap-Filling für Bulk-Operationen)."""
    result = await db.execute(select(Model.id).order_by(Model.id))
    existing_ids = set(result.scalars().all())
    ids: list[int] = []
    i = 1
    while len(ids) < count:
        if i not in existing_ids:
            ids.append(i)
        i += 1
    return ids
