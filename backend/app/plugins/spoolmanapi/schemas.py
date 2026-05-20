"""Pydantic schemas mirroring the Spoolman API data shapes."""
from __future__ import annotations

from datetime import datetime
from typing import Any, Generic, TypeVar

from pydantic import BaseModel, Field

T = TypeVar("T")


class SpoolmanPage(BaseModel, Generic[T]):
    """Paginated list response matching the Spoolman API envelope."""

    items: list[T]
    total: int


class Vendor(BaseModel):
    id: int
    registered: datetime | None = None
    name: str
    comment: str | None = None
    empty_spool_weight: float | None = None
    external_id: str | None = None
    extra: dict[str, Any] = Field(default_factory=dict)


class Filament(BaseModel):
    id: int
    registered: datetime | None = None
    name: str | None = None
    vendor: Vendor | None = None
    material: str | None = None
    price: float | None = None
    density: float | None = None
    diameter: float | None = None
    weight: float | None = None
    spool_weight: float | None = None
    article_number: str | None = None
    comment: str | None = None
    settings_extruder_temp: int | None = None
    settings_bed_temp: int | None = None
    color_hex: str | None = None
    multi_color_hexes: str | None = None
    multi_color_direction: str | None = None
    external_id: str | None = None
    extra: dict[str, Any] = Field(default_factory=dict)


class Spool(BaseModel):
    id: int
    registered: datetime | None = None
    first_used: datetime | None = None
    last_used: datetime | None = None
    filament: Filament
    price: float | None = None
    initial_weight: float | None = None
    spool_weight: float | None = None
    remaining_weight: float | None = None
    used_weight: float | None = None
    remaining_length: float | None = None
    used_length: float | None = None
    location: str | None = None
    lot_nr: str | None = None
    comment: str | None = None
    archived: bool = False
    extra: dict[str, Any] = Field(default_factory=dict)


class SpoolParameters(BaseModel):
    """Parameters for spool create/update operations.

    Reserved for future CRUD routes (PATCH /spool, POST /spool, etc.).
    Not used by the current read-only router.
    """

    filament_id: int
    price: float | None = None
    initial_weight: float | None = None
    spool_weight: float | None = None
    remaining_weight: float | None = None
    used_weight: float | None = None
    location: str | None = None
    lot_nr: str | None = None
    comment: str | None = None
    first_used: datetime | None = None
    last_used: datetime | None = None
    archived: bool = False
    extra: dict[str, Any] = Field(default_factory=dict)
