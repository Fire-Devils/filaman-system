"""Exact named-color filtering shared by paginated inventory lists."""

from fastapi import HTTPException
from sqlalchemy import LargeBinary, cast, or_

from app.models import Color, Filament, FilamentColor


def filament_color_filter(names: list[str] | None, unassigned: bool, dialect: str):
    if names and (len(names) > 200 or any(len(name) > 100 for name in names)):
        raise HTTPException(422, detail={"message": "color_name accepts up to 200 names of 100 characters"})
    if not names and not unassigned:
        return None
    # MySQL's default text collation folds case; browser color names are exact.
    binary = dialect in {"mysql", "mariadb"}
    name_column = cast(Color.name, LargeBinary) if binary else Color.name
    values = [name.encode("utf-8") for name in names or []] if binary else names
    conditions = []
    if names:
        conditions.append(Filament.filament_colors.any(FilamentColor.color.has(name_column.in_(values))))
    if unassigned:
        conditions.append(~Filament.filament_colors.any(FilamentColor.color.has(name_column != (b"" if binary else ""))))
    return or_(*conditions)
