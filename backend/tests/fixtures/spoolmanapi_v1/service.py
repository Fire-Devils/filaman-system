"""Frozen v1.0.0 serialization contract; only its read routes are needed here."""

from __future__ import annotations

import math

from app.models.filament import Filament, Manufacturer
from app.models.spool import Spool
from sqlalchemy.ext.asyncio import AsyncSession

from . import schemas


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
            extra=custom_fields,
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
            extra=custom_fields,
        )
