"""Reviewed, atomic color cleanup without changing the existing CRUD contract."""

import hashlib
import json
from contextlib import asynccontextmanager
from datetime import UTC, datetime

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field, JsonValue, model_validator
from sqlalchemy import delete, select, update
from sqlalchemy.exc import IntegrityError

from app.api.deps import DBSession, PrincipalDep, RequirePermission
from app.core.event_bus import event_bus
from app.models import Color, Filament, FilamentColor
from app.utils.colors import normalize_hex_color

router = APIRouter()


class ReviewedColor(BaseModel):
    id: int = Field(gt=0)
    token: str = Field(min_length=64, max_length=64)


class CleanupRequest(BaseModel):
    records: list[ReviewedColor] = Field(min_length=1)

    @model_validator(mode="after")
    def unique_ids(self):
        if len({record.id for record in self.records}) != len(self.records):
            raise ValueError("Review each color once")
        return self


class MergeRequest(CleanupRequest):
    survivor_id: int = Field(gt=0)
    name: str = Field(min_length=1, max_length=100)


class CleanupColor(BaseModel):
    id: int
    name: str
    hex_code: str
    custom_fields: dict[str, JsonValue] | None
    usage_count: int
    token: str


class CleanupSnapshot(BaseModel):
    items: list[CleanupColor]
    groups: list[list[int]]


class CleanupResult(BaseModel):
    changed: int


def duplicate_key(hex_code: str) -> str | None:
    try:
        normalized = normalize_hex_color(hex_code)
    except ValueError:
        return None
    return normalized[:-2] if len(normalized) == 9 and normalized.endswith("FF") else normalized


async def snapshot(db, ids: list[int] | None = None, *, lock: bool = False) -> CleanupSnapshot:
    query = select(Color).order_by(Color.id).execution_options(populate_existing=True)
    links_query = select(FilamentColor).order_by(FilamentColor.id).execution_options(populate_existing=True)
    if ids is not None:
        query = query.where(Color.id.in_(ids))
        links_query = links_query.where(FilamentColor.color_id.in_(ids))
    if lock:
        query = query.with_for_update()
        links_query = links_query.with_for_update()
    colors = (await db.execute(query)).scalars().all()
    links: dict[int, list] = {}
    for link in (await db.execute(links_query)).scalars():
        links.setdefault(link.color_id, []).append([
            link.id, link.filament_id, link.position, link.display_name_override, str(link.created_at),
        ])
    items = []
    groups: dict[str, list[int]] = {}
    for color in colors:
        assignments = links.get(color.id, [])
        data = {
            "id": color.id, "name": color.name, "hex_code": color.hex_code,
            "custom_fields": color.custom_fields, "usage_count": len(assignments),
        }
        token_data = [data, color.record_token, str(color.created_at), str(color.updated_at), assignments]
        token = hashlib.sha256(json.dumps(token_data, sort_keys=True, ensure_ascii=True, allow_nan=False).encode()).hexdigest()
        items.append(CleanupColor(**data, token=token))
        key = duplicate_key(color.hex_code)
        if key is not None:
            groups.setdefault(key, []).append(color.id)
    return CleanupSnapshot(items=items, groups=[group for group in groups.values() if len(group) > 1])


def conflict():
    return HTTPException(409, detail={"code": "color_review_changed", "message": "Colors changed or are in use. Refresh and review again."})


def name_collision():
    return HTTPException(409, detail={
        "code": "color_name_collision",
        "message": "Another color already has this name and hex. Choose a different name or select that color too.",
    })


def _is_name_collision(error: IntegrityError) -> bool:
    original = error.orig
    message = str(original)
    if message == "UNIQUE constraint failed: colors.name, colors.hex_code":
        return True
    if (getattr(original, "sqlstate", None) or getattr(original, "pgcode", None)) == "23505":
        constraint = getattr(getattr(original, "diag", None), "constraint_name", None) or getattr(original.__cause__, "constraint_name", None)
        return constraint == "uq_colors_name_hex" or message.splitlines()[0].endswith('unique constraint "uq_colors_name_hex"')
    if len(original.args) > 1 and original.args[0] == 1062:
        return str(original.args[1]).rpartition("for key ")[2].split(".")[-1].strip("'`") == "uq_colors_name_hex"
    return False


@asynccontextmanager
async def reviewed_transaction(db, records: list[ReviewedColor]):
    ids = sorted(record.id for record in records)
    try:
        if db.get_bind().dialect.name == "sqlite":
            # Acquire SQLite's writer lock before reading references; preserve review timestamps.
            await db.execute(update(Color).where(Color.id.in_(ids)).values(id=Color.id, updated_at=Color.updated_at))
        current = await snapshot(db, ids, lock=True)
        tokens = {color.id: color.token for color in current.items}
        if any(tokens.get(record.id) != record.token for record in records):
            raise conflict()
        yield current.items
        await db.commit()
    except Exception:
        await db.rollback()
        raise


@router.get("/cleanup", response_model=CleanupSnapshot)
async def preview_cleanup(db: DBSession, principal: PrincipalDep):
    return await snapshot(db)


@router.post("/bulk-delete", response_model=CleanupResult, dependencies=[RequirePermission("colors:delete")])
async def bulk_delete_colors(data: CleanupRequest, db: DBSession):
    async with reviewed_transaction(db, data.records) as colors:
        if any(color.usage_count for color in colors):
            raise conflict()
        await db.execute(delete(Color).where(Color.id.in_([color.id for color in colors])))
    await event_bus.publish({"event": "colors_changed"})
    return CleanupResult(changed=len(colors))


@router.post("/merge", response_model=CleanupResult, dependencies=[
    RequirePermission("colors:delete"), RequirePermission("colors:update"), RequirePermission("filaments:update"),
])
async def merge_colors(data: MergeRequest, db: DBSession):
    name = data.name.strip()
    async with reviewed_transaction(db, data.records) as colors:
        by_id = {color.id: color for color in colors}
        keys = {duplicate_key(color.hex_code) for color in colors}
        if len(colors) < 2 or data.survivor_id not in by_id or None in keys or len(keys) != 1 or not name:
            raise HTTPException(422, detail={"code": "invalid_merge", "message": "Choose matching colors and a survivor."})
        collision = await db.scalar(select(Color.id).where(
            Color.name == name, Color.hex_code == by_id[data.survivor_id].hex_code,
            Color.id.not_in(list(by_id)),
        ).limit(1))
        if collision is not None:
            raise name_collision()
        fields = {}
        for color in colors:
            for key, value in (color.custom_fields or {}).items():
                if key in fields and json.dumps(fields[key], sort_keys=True, allow_nan=False) != json.dumps(value, sort_keys=True, allow_nan=False):
                    raise HTTPException(422, detail={
                        "code": "color_metadata_conflict",
                        "message": "These colors contain conflicting stored data. No colors were changed. Leave them separate or resolve the data in the integration that created it.",
                    })
                fields[key] = value
        source_ids = [color.id for color in colors if color.id != data.survivor_id]
        affected = select(FilamentColor.filament_id).where(FilamentColor.color_id.in_(list(by_id)))
        # shortcut: MySQL retains whole-second precision; use DATETIME(6) if sub-second sync is required.
        await db.execute(update(Filament).where(Filament.id.in_(affected)).values(updated_at=datetime.now(UTC)))
        await db.execute(update(FilamentColor).where(FilamentColor.color_id.in_(source_ids)).values(color_id=data.survivor_id))
        await db.execute(delete(Color).where(Color.id.in_(source_ids)))
        try:
            await db.execute(update(Color).where(Color.id == data.survivor_id).values(name=name, custom_fields=fields or None))
        except IntegrityError as exc:
            if _is_name_collision(exc):
                raise name_collision() from exc
            raise
    await event_bus.publish({"event": "colors_changed"}, {"event": "filaments_changed"})
    return CleanupResult(changed=len(source_ids))
