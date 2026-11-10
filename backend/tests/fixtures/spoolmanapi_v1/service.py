"""v1.0.0 read serializers with the published v1.2 JSON extra encoding."""

from __future__ import annotations

import json
import math
from pathlib import Path

from app.models.filament import Filament, Manufacturer
from app.models.spool import Spool
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from . import schemas

_MANIFEST_VERSION = json.loads(Path(__file__).with_name("plugin.json").read_text())["version"]


def _wire_extra(custom_fields: dict) -> dict:
    if _MANIFEST_VERSION == "1.0.0":
        return custom_fields
    return {key: json.dumps(value) for key, value in custom_fields.items()}


def _weight_to_length_mm(
    weight_g: float, diameter_mm: float, density_g_cm3: float
) -> float:
    """Convert net filament weight (g) to length (mm)."""
    radius_cm = (diameter_mm / 2) / 10
    cross_section_cm2 = math.pi * radius_cm**2
    volume_cm3 = weight_g / density_g_cm3
    length_cm = volume_cm3 / cross_section_cm2
    return length_cm * 10


class SpoolmanService:
    def __init__(self, db: AsyncSession):
        self.db = db

    async def create_filament(self, data):
        filament = Filament(
            designation=data.name, manufacturer_id=data.vendor_id,
            material_type="PLA", diameter_mm=1.75,
            custom_fields={"settings_extruder_temp": data.settings_extruder_temp},
        )
        self.db.add(filament)
        await self.db.commit()
        return self._filament_to_schema(await self._get_filament(filament.id))

    async def update_filament(self, filament_id, data):
        filament = await self._get_filament(filament_id)
        if filament is None:
            return None
        changes = data.model_dump(exclude_unset=True)
        if "vendor_id" in changes:
            filament.manufacturer_id = changes["vendor_id"]
        custom = dict(filament.custom_fields or {})
        for key in ("settings_extruder_temp", "settings_bed_temp"):
            if key in changes:
                if changes[key] is None:
                    custom.pop(key, None)
                else:
                    custom[key] = changes[key]
        filament.custom_fields = custom or None
        await self.db.commit()
        return self._filament_to_schema(await self._get_filament(filament.id))

    async def _get_filament(self, filament_id):
        return await self.db.scalar(
            select(Filament).where(Filament.id == filament_id).options(
                selectinload(Filament.manufacturer),
                selectinload(Filament.filament_colors),
            ).execution_options(populate_existing=True)
        )

    async def export_filaments(self):
        return await self._export(Filament)

    async def export_spools(self):
        return await self._export(Spool)

    async def _export(self, model):
        result = await self.db.execute(select(model.id, model.custom_fields))
        return [dict(row) for row in result.mappings()]

    async def get_extra_fields(self, entity_type):
        return []

    def _manufacturer_to_vendor(self, manufacturer: Manufacturer) -> schemas.Vendor:
        extra = dict(manufacturer.custom_fields or {})
        comment = extra.pop("comment", None)
        external_id = extra.pop("external_id", None)
        return schemas.Vendor(
            id=manufacturer.id,
            registered=manufacturer.created_at,
            name=manufacturer.name,
            comment=comment,
            empty_spool_weight=manufacturer.empty_spool_weight_g,
            external_id=external_id,
            extra=extra,
        )

    def _filament_to_schema(self, filament: Filament) -> schemas.Filament:
        vendor = (
            self._manufacturer_to_vendor(filament.manufacturer)
            if filament.manufacturer
            else None
        )
        colors = sorted(filament.filament_colors or [], key=lambda item: item.position)
        primary_color = None
        if colors:
            primary = next((item for item in colors if item.position == 1), colors[0])
            if primary.color and primary.color.hex_code:
                primary_color = primary.color.hex_code.lstrip("#")

        if filament.color_mode == "multi":
            multi_colors = [
                item.color.hex_code.lstrip("#")
                for item in colors
                if item.color and item.color.hex_code
            ]
        else:
            multi_colors = [
                item.color.hex_code.lstrip("#")
                for item in colors
                if item.position > 1 and item.color and item.color.hex_code
            ]
        multi_color_hexes = ",".join(multi_colors) if multi_colors else None

        custom_fields = dict(filament.custom_fields or {})
        article_number = custom_fields.pop("article_number", None)
        comment = custom_fields.pop("comment", None)
        settings_extruder_temp = custom_fields.pop("settings_extruder_temp", None)
        settings_bed_temp = custom_fields.pop("settings_bed_temp", None)
        external_id = custom_fields.pop("external_id", None)

        return schemas.Filament(
            id=filament.id,
            registered=filament.created_at,
            name=filament.designation,
            vendor=vendor,
            material=filament.material_type,
            price=filament.price,
            density=filament.density_g_cm3,
            diameter=filament.diameter_mm,
            weight=filament.raw_material_weight_g,
            spool_weight=filament.default_spool_weight_g,
            article_number=article_number,
            comment=comment,
            settings_extruder_temp=settings_extruder_temp,
            settings_bed_temp=settings_bed_temp,
            color_hex=primary_color,
            multi_color_hexes=multi_color_hexes,
            multi_color_direction=filament.multi_color_style,
            external_id=external_id,
            extra=_wire_extra(custom_fields),
        )

    def _spool_to_schema(self, spool: Spool) -> schemas.Spool:
        filament = self._filament_to_schema(spool.filament)
        initial_weight = None
        if (
            spool.initial_total_weight_g is not None
            and spool.empty_spool_weight_g is not None
        ):
            initial_weight = spool.initial_total_weight_g - spool.empty_spool_weight_g

        used_weight = None
        if initial_weight is not None and spool.remaining_weight_g is not None:
            used_weight = initial_weight - spool.remaining_weight_g

        remaining_length = None
        used_length = None
        if filament.density and filament.diameter:
            if spool.remaining_weight_g is not None:
                remaining_length = _weight_to_length_mm(
                    spool.remaining_weight_g, filament.diameter, filament.density
                )
            if used_weight is not None:
                used_length = _weight_to_length_mm(
                    used_weight, filament.diameter, filament.density
                )

        custom_fields = dict(spool.custom_fields or {})
        comment = custom_fields.pop("comment", None)

        return schemas.Spool(
            id=spool.id,
            registered=spool.created_at,
            first_used=spool.stocked_in_at,
            last_used=spool.last_used_at,
            filament=filament,
            price=spool.purchase_price,
            initial_weight=initial_weight,
            spool_weight=spool.empty_spool_weight_g,
            remaining_weight=spool.remaining_weight_g,
            used_weight=used_weight,
            remaining_length=remaining_length,
            used_length=used_length,
            location=spool.location.name if spool.location else None,
            lot_nr=spool.lot_number,
            comment=comment,
            archived=spool.status.key == "archived" if spool.status else False,
            extra=_wire_extra(custom_fields),
        )
