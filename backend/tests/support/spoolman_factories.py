"""Focused object and source-definition factories for Spoolman tests."""

from __future__ import annotations

from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.models.filament import Filament, Manufacturer


async def create_imported_filament(
    db: AsyncSession,
    *,
    spoolman_id: int,
    custom_fields: dict[str, Any] | None = None,
    local_definitions: dict[str, Any] | None = None,
    designation: str | None = None,
) -> Filament:
    """Create one imported filament while leaving scenario values explicit."""
    manufacturer = Manufacturer(name=f"Test vendor {spoolman_id}")
    db.add(manufacturer)
    await db.flush()
    fields = {"spoolman_id": spoolman_id, **(custom_fields or {})}
    filament = Filament(
        manufacturer_id=manufacturer.id,
        designation=designation or f"Imported filament {spoolman_id}",
        material_type="PLA",
        diameter_mm=1.75,
        custom_fields=fields,
        custom_field_definitions=local_definitions,
    )
    db.add(filament)
    await db.commit()
    return filament


def source_definition(
    *,
    key: str,
    field_type: str,
    name: str | None = None,
    unit: str | None = None,
    choices: list[str] | None = None,
    multi_choice: bool | None = None,
) -> dict[str, Any]:
    """Build a source definition without hiding business-relevant values."""
    definition: dict[str, Any] = {
        "key": key,
        "name": name or key.replace("_", " ").title(),
        "field_type": field_type,
    }
    if unit is not None:
        definition["unit"] = unit
    if choices is not None:
        definition["choices"] = choices
    if multi_choice is not None:
        definition["multi_choice"] = multi_choice
    return definition
