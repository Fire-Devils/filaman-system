"""Exact named-color filtering shared by paginated inventory lists."""

from fastapi import HTTPException
from sqlalchemy import LargeBinary, cast, func, or_

from app.models import Color, Filament, FilamentColor


def filament_has_named_color():
    return Filament.filament_colors.any(FilamentColor.color.has(func.length(Color.name) > 0))


def filament_color_filter(
    names: list[str] | None, unassigned: bool, dialect: str, color_ids: list[int] | None = None,
):
    if len(names or []) + len(color_ids or []) > 200 or any(len(name) > 100 for name in names or []):
        raise HTTPException(422, detail={"message": "Select up to 200 color names or IDs. Names may have up to 100 characters."})
    max_color_id = 2**31 - 1 if dialect == "postgresql" else 2**63 - 1
    if any(not 1 <= color_id <= max_color_id for color_id in color_ids or []):
        raise HTTPException(422, detail={"message": "Color ID is outside the supported range."})
    if not names and not color_ids and not unassigned:
        return None
    # MySQL's default text collation folds case; browser color names are exact.
    binary = dialect in {"mysql", "mariadb"}
    name_column = cast(Color.name, LargeBinary) if binary else Color.name
    values = [name.encode("utf-8") for name in names or []] if binary else names
    conditions = []
    if names:
        conditions.append(Filament.filament_colors.any(FilamentColor.color.has(name_column.in_(values))))
    if color_ids:
        conditions.append(Filament.filament_colors.any(FilamentColor.color_id.in_(color_ids)))
    if unassigned:
        conditions.append(~filament_has_named_color())
    return or_(*conditions)
