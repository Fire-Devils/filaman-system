from __future__ import annotations

import logging
import math
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select, func, or_
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.models.filament import Manufacturer, Filament, Color, FilamentColor
from app.models.spool import Spool, SpoolStatus
from app.models.location import Location
from app.models.app_settings import AppSettings
from app.services.spool_service import SpoolService
from app.utils.colors import normalize_hex_color

from . import schemas

logger = logging.getLogger(__name__)


def _weight_to_length_mm(
    weight_g: float, diameter_mm: float, density_g_cm3: float
) -> float:
    """Convert net filament weight (g) to length (mm)."""
    radius_cm = (diameter_mm / 2) / 10
    cross_section_cm2 = math.pi * radius_cm**2
    volume_cm3 = weight_g / density_g_cm3
    length_cm = volume_cm3 / cross_section_cm2
    return length_cm * 10


def _length_to_weight_g(
    length_mm: float, diameter_mm: float, density_g_cm3: float
) -> float:
    """Convert filament length (mm) to net weight (g)."""
    radius_cm = (diameter_mm / 2) / 10
    cross_section_cm2 = math.pi * radius_cm**2
    length_cm = length_mm / 10
    volume_cm3 = cross_section_cm2 * length_cm
    return volume_cm3 * density_g_cm3


class SpoolmanService:
    def __init__(self, db: AsyncSession):
        self.db = db

    async def list_vendors(
        self,
        name: str | None = None,
        external_id: str | None = None,
        sort: str | None = None,
        limit: int | None = None,
        offset: int = 0,
    ) -> tuple[list[schemas.Vendor], int]:
        query = select(Manufacturer)

        if name:
            query = self._apply_text_filter(query, Manufacturer.name, name)
        if external_id is not None:
            external_field = Manufacturer.custom_fields["external_id"].as_string()
            query = self._apply_text_filter(query, external_field, external_id)

        query = self._apply_sort(
            query,
            sort,
            {
                "name": Manufacturer.name,
                "id": Manufacturer.id,
                "registered": Manufacturer.created_at,
            },
            default_column=Manufacturer.id,
        )

        total_count = await self._count_query(query, Manufacturer.id)
        query = self._apply_pagination(query, limit, offset)

        result = await self.db.execute(query)
        vendors = result.scalars().all()
        return [self._manufacturer_to_vendor(vendor) for vendor in vendors], total_count

    async def get_vendor(self, vendor_id: int) -> schemas.Vendor | None:
        result = await self.db.execute(
            select(Manufacturer).where(Manufacturer.id == vendor_id)
        )
        vendor = result.scalar_one_or_none()
        if not vendor:
            return None
        return self._manufacturer_to_vendor(vendor)

    async def create_vendor(self, data: schemas.VendorParameters) -> schemas.Vendor:
        custom_fields: dict[str, Any] = {}
        if data.extra:
            custom_fields.update(data.extra)
        if data.comment is not None:
            custom_fields["comment"] = data.comment
        if data.external_id is not None:
            custom_fields["external_id"] = data.external_id

        vendor = Manufacturer(
            name=data.name,
            empty_spool_weight_g=data.empty_spool_weight,
            custom_fields=custom_fields or None,
        )
        self.db.add(vendor)
        await self.db.commit()
        vendor = await self._get_manufacturer(vendor.id)
        return self._manufacturer_to_vendor(vendor)

    async def update_vendor(
        self, vendor_id: int, data: schemas.VendorUpdateParameters
    ) -> schemas.Vendor | None:
        result = await self.db.execute(
            select(Manufacturer).where(Manufacturer.id == vendor_id)
        )
        vendor = result.scalar_one_or_none()
        if not vendor:
            return None

        payload = data.model_dump(exclude_unset=True)
        if "name" in payload:
            vendor.name = payload["name"]
        if "empty_spool_weight" in payload:
            vendor.empty_spool_weight_g = payload["empty_spool_weight"]

        custom_fields = dict(vendor.custom_fields or {})
        if "comment" in payload:
            if payload["comment"] is None:
                custom_fields.pop("comment", None)
            else:
                custom_fields["comment"] = payload["comment"]
        if "external_id" in payload:
            if payload["external_id"] is None:
                custom_fields.pop("external_id", None)
            else:
                custom_fields["external_id"] = payload["external_id"]
        if "extra" in payload and payload["extra"]:
            custom_fields.update(payload["extra"])

        vendor.custom_fields = custom_fields or None
        await self.db.commit()
        vendor = await self._get_manufacturer(vendor.id)
        return self._manufacturer_to_vendor(vendor)

    async def delete_vendor(self, vendor_id: int) -> bool:
        result = await self.db.execute(
            select(Manufacturer).where(Manufacturer.id == vendor_id)
        )
        vendor = result.scalar_one_or_none()
        if not vendor:
            return False
        await self.db.delete(vendor)
        await self.db.commit()
        return True

    async def list_filaments(
        self,
        vendor_name: str | None = None,
        vendor_id: str | None = None,
        name: str | None = None,
        material: str | None = None,
        article_number: str | None = None,
        color_hex: str | None = None,
        external_id: str | None = None,
        sort: str | None = None,
        limit: int | None = None,
        offset: int = 0,
    ) -> tuple[list[schemas.Filament], int]:
        query = (
            select(Filament)
            .options(
                selectinload(Filament.manufacturer),
                selectinload(Filament.filament_colors).selectinload(
                    FilamentColor.color
                ),
            )
            .outerjoin(Manufacturer, Filament.manufacturer_id == Manufacturer.id)
        )

        if vendor_name:
            query = self._apply_text_filter(query, Manufacturer.name, vendor_name)
        if vendor_id:
            vendor_ids, include_null = self._parse_id_list(vendor_id)
            conditions: list[Any] = []
            if vendor_ids:
                conditions.append(Filament.manufacturer_id.in_(vendor_ids))
            if include_null:
                conditions.append(Filament.manufacturer_id.is_(None))
            if conditions:
                query = query.where(or_(*conditions))
        if name:
            query = self._apply_text_filter(query, Filament.designation, name)
        if material:
            query = self._apply_text_filter(query, Filament.material_type, material)
        if article_number is not None:
            article_field = Filament.custom_fields["article_number"].as_string()
            query = self._apply_text_filter(query, article_field, article_number)
        if external_id is not None:
            external_field = Filament.custom_fields["external_id"].as_string()
            query = self._apply_text_filter(query, external_field, external_id)
        if color_hex:
            normalized = color_hex.strip().lstrip("#").upper()
            query = query.outerjoin(
                FilamentColor, FilamentColor.filament_id == Filament.id
            ).outerjoin(Color, FilamentColor.color_id == Color.id)
            query = query.where(
                func.upper(func.replace(Color.hex_code, "#", "")) == normalized
            )

        query = self._apply_sort(
            query,
            sort,
            {
                "name": Filament.designation,
                "vendor.name": Manufacturer.name,
                "material": Filament.material_type,
                "id": Filament.id,
                "registered": Filament.created_at,
                "density": Filament.density_g_cm3,
                "diameter": Filament.diameter_mm,
                "weight": Filament.raw_material_weight_g,
                "spool_weight": Filament.default_spool_weight_g,
                "price": Filament.price,
            },
            default_column=Filament.id,
        )

        total_count = await self._count_query(query, Filament.id)
        query = self._apply_pagination(query, limit, offset)

        result = await self.db.execute(query)
        filaments = result.scalars().unique().all()
        return [
            self._filament_to_schema(filament) for filament in filaments
        ], total_count

    async def get_filament(self, filament_id: int) -> schemas.Filament | None:
        filament = await self._get_filament(filament_id)
        if not filament:
            return None
        return self._filament_to_schema(filament)

    async def create_filament(
        self, data: schemas.FilamentParameters
    ) -> schemas.Filament:
        custom_fields: dict[str, Any] = {}
        if data.extra:
            custom_fields.update(data.extra)
        if data.article_number is not None:
            custom_fields["article_number"] = data.article_number
        if data.comment is not None:
            custom_fields["comment"] = data.comment
        if data.settings_extruder_temp is not None:
            custom_fields["settings_extruder_temp"] = data.settings_extruder_temp
        if data.settings_bed_temp is not None:
            custom_fields["settings_bed_temp"] = data.settings_bed_temp
        if data.external_id is not None:
            custom_fields["external_id"] = data.external_id

        color_mode = "multi" if data.multi_color_hexes else "single"
        filament = Filament(
            designation=data.name or "Unnamed",
            manufacturer_id=data.vendor_id,
            material_type=data.material or "PLA",
            density_g_cm3=data.density,
            diameter_mm=data.diameter or 1.75,
            raw_material_weight_g=data.weight,
            default_spool_weight_g=data.spool_weight,
            price=data.price,
            color_mode=color_mode,
            multi_color_style=data.multi_color_direction,
            custom_fields=custom_fields or None,
        )
        self.db.add(filament)
        await self.db.flush()
        await self._apply_filament_colors(
            filament, data.color_hex, data.multi_color_hexes
        )
        await self.db.commit()
        filament = await self._get_filament(filament.id)
        return self._filament_to_schema(filament)

    async def update_filament(
        self, filament_id: int, data: schemas.FilamentUpdateParameters
    ) -> schemas.Filament | None:
        filament = await self._get_filament(filament_id)
        if not filament:
            return None

        payload = data.model_dump(exclude_unset=True)
        if "name" in payload:
            filament.designation = payload["name"] or "Unnamed"
        if "vendor_id" in payload:
            filament.manufacturer_id = payload["vendor_id"]
        if "material" in payload:
            filament.material_type = payload["material"] or "PLA"
        if "density" in payload:
            filament.density_g_cm3 = payload["density"]
        if "diameter" in payload:
            filament.diameter_mm = payload["diameter"] or 1.75
        if "weight" in payload:
            filament.raw_material_weight_g = payload["weight"]
        if "spool_weight" in payload:
            filament.default_spool_weight_g = payload["spool_weight"]
        if "price" in payload:
            filament.price = payload["price"]
        if "multi_color_direction" in payload:
            filament.multi_color_style = payload["multi_color_direction"]

        custom_fields = dict(filament.custom_fields or {})
        if "article_number" in payload:
            if payload["article_number"] is None:
                custom_fields.pop("article_number", None)
            else:
                custom_fields["article_number"] = payload["article_number"]
        if "comment" in payload:
            if payload["comment"] is None:
                custom_fields.pop("comment", None)
            else:
                custom_fields["comment"] = payload["comment"]
        if "settings_extruder_temp" in payload:
            if payload["settings_extruder_temp"] is None:
                custom_fields.pop("settings_extruder_temp", None)
            else:
                custom_fields["settings_extruder_temp"] = payload[
                    "settings_extruder_temp"
                ]
        if "settings_bed_temp" in payload:
            if payload["settings_bed_temp"] is None:
                custom_fields.pop("settings_bed_temp", None)
            else:
                custom_fields["settings_bed_temp"] = payload["settings_bed_temp"]
        if "external_id" in payload:
            if payload["external_id"] is None:
                custom_fields.pop("external_id", None)
            else:
                custom_fields["external_id"] = payload["external_id"]
        if "extra" in payload and payload["extra"]:
            custom_fields.update(payload["extra"])

        filament.custom_fields = custom_fields or None

        if "multi_color_hexes" in payload or "color_hex" in payload:
            filament.color_mode = (
                "multi" if payload.get("multi_color_hexes") else "single"
            )
            await self._apply_filament_colors(
                filament,
                payload.get("color_hex"),
                payload.get("multi_color_hexes"),
                clear_existing=True,
            )
        elif "multi_color_direction" in payload:
            filament.color_mode = filament.color_mode or "single"

        await self.db.commit()
        filament = await self._get_filament(filament.id)
        return self._filament_to_schema(filament)

    async def delete_filament(self, filament_id: int) -> bool:
        filament = await self._get_filament(filament_id)
        if not filament:
            return False
        await self.db.delete(filament)
        await self.db.commit()
        return True

    async def list_spools(
        self,
        filament_name: str | None = None,
        filament_id: str | None = None,
        filament_material: str | None = None,
        vendor_name: str | None = None,
        vendor_id: str | None = None,
        location: str | None = None,
        lot_nr: str | None = None,
        allow_archived: bool = False,
        sort: str | None = None,
        limit: int | None = None,
        offset: int = 0,
    ) -> tuple[list[schemas.Spool], int]:
        query = (
            select(Spool)
            .options(
                selectinload(Spool.filament).selectinload(Filament.manufacturer),
                selectinload(Spool.filament)
                .selectinload(Filament.filament_colors)
                .selectinload(FilamentColor.color),
                selectinload(Spool.status),
                selectinload(Spool.location),
            )
            .join(Filament, Spool.filament_id == Filament.id)
            .outerjoin(Manufacturer, Filament.manufacturer_id == Manufacturer.id)
            .outerjoin(Location, Spool.location_id == Location.id)
            .join(SpoolStatus, Spool.status_id == SpoolStatus.id)
        )

        if not allow_archived:
            query = query.where(SpoolStatus.key != "archived")
        if filament_name:
            query = self._apply_text_filter(query, Filament.designation, filament_name)
        if filament_id:
            filament_ids, _ = self._parse_id_list(filament_id)
            if filament_ids:
                query = query.where(Spool.filament_id.in_(filament_ids))
        if filament_material:
            query = self._apply_text_filter(
                query, Filament.material_type, filament_material
            )
        if vendor_name:
            query = self._apply_text_filter(query, Manufacturer.name, vendor_name)
        if vendor_id:
            vendor_ids, include_null = self._parse_id_list(vendor_id)
            conditions: list[Any] = []
            if vendor_ids:
                conditions.append(Filament.manufacturer_id.in_(vendor_ids))
            if include_null:
                conditions.append(Filament.manufacturer_id.is_(None))
            if conditions:
                query = query.where(or_(*conditions))
        if location:
            query = self._apply_text_filter(query, Location.name, location)
        if lot_nr:
            query = self._apply_text_filter(query, Spool.lot_number, lot_nr)

        query = self._apply_sort(
            query,
            sort,
            {
                "id": Spool.id,
                "registered": Spool.created_at,
                "first_used": Spool.stocked_in_at,
                "last_used": Spool.last_used_at,
                "filament.name": Filament.designation,
                "filament.material": Filament.material_type,
                "filament.vendor.name": Manufacturer.name,
                "location": Location.name,
                "lot_nr": Spool.lot_number,
                "remaining_weight": Spool.remaining_weight_g,
            },
            default_column=Spool.id,
        )

        total_count = await self._count_query(query, Spool.id)
        query = self._apply_pagination(query, limit, offset)

        result = await self.db.execute(query)
        spools = result.scalars().unique().all()
        return [self._spool_to_schema(spool) for spool in spools], total_count

    async def get_spool(self, spool_id: int) -> schemas.Spool | None:
        spool = await self._get_spool(spool_id)
        if not spool:
            return None
        return self._spool_to_schema(spool)

    async def create_spool(self, data: schemas.SpoolParameters) -> schemas.Spool:
        custom_fields: dict[str, Any] = {}
        if data.extra:
            custom_fields.update(data.extra)
        if data.comment is not None:
            custom_fields["comment"] = data.comment

        location_id = await self._resolve_location(data.location)
        status_id = await self._resolve_status(data.archived)

        spool = Spool(
            filament_id=data.filament_id,
            status_id=status_id,
            stocked_in_at=data.first_used,
            last_used_at=data.last_used,
            purchase_price=data.price,
            lot_number=data.lot_nr,
            empty_spool_weight_g=data.spool_weight,
            location_id=location_id,
            custom_fields=custom_fields or None,
        )

        self._apply_spool_weights(
            spool,
            data.initial_weight,
            data.spool_weight,
            data.remaining_weight,
            data.used_weight,
        )
        self.db.add(spool)
        await self.db.commit()
        spool = await self._get_spool(spool.id)
        return self._spool_to_schema(spool)

    async def update_spool(
        self, spool_id: int, data: schemas.SpoolUpdateParameters
    ) -> schemas.Spool | None:
        spool = await self._get_spool(spool_id)
        if not spool:
            return None

        payload = data.model_dump(exclude_unset=True)
        if "filament_id" in payload:
            spool.filament_id = payload["filament_id"]
        if "first_used" in payload:
            spool.stocked_in_at = payload["first_used"]
        if "last_used" in payload:
            spool.last_used_at = payload["last_used"]
        if "price" in payload:
            spool.purchase_price = payload["price"]
        if "lot_nr" in payload:
            spool.lot_number = payload["lot_nr"]
        if "spool_weight" in payload:
            spool.empty_spool_weight_g = payload["spool_weight"]
        if "location" in payload:
            spool.location_id = await self._resolve_location(payload["location"])
        if "archived" in payload and payload["archived"] is not None:
            spool.status_id = await self._resolve_status(payload["archived"])

        custom_fields = dict(spool.custom_fields or {})
        if "comment" in payload:
            if payload["comment"] is None:
                custom_fields.pop("comment", None)
            else:
                custom_fields["comment"] = payload["comment"]
        if "extra" in payload and payload["extra"]:
            custom_fields.update(payload["extra"])
        spool.custom_fields = custom_fields or None

        if any(
            key in payload
            for key in (
                "initial_weight",
                "spool_weight",
                "remaining_weight",
                "used_weight",
            )
        ):
            self._apply_spool_weights(
                spool,
                payload.get("initial_weight"),
                payload.get("spool_weight"),
                payload.get("remaining_weight"),
                payload.get("used_weight"),
            )

        await self.db.commit()
        spool = await self._get_spool(spool.id)
        return self._spool_to_schema(spool)

    async def delete_spool(self, spool_id: int) -> bool:
        spool = await self._get_spool(spool_id)
        if not spool:
            return False
        spool.status_id = await self._resolve_status(True)
        await self.db.commit()
        return True

    async def use_spool(
        self, spool_id: int, data: schemas.SpoolUseParameters
    ) -> schemas.Spool | None:
        spool = await self._get_spool(spool_id)
        if not spool:
            return None

        now = datetime.now(timezone.utc)
        if data.use_weight is not None:
            await SpoolService(self.db).record_consumption(
                spool,
                delta_weight_g=data.use_weight,
                event_at=now,
                source="spoolman_api",
            )
        elif data.use_length is not None:
            filament = spool.filament
            if filament and filament.diameter_mm and filament.density_g_cm3:
                weight_g = _length_to_weight_g(
                    data.use_length, filament.diameter_mm, filament.density_g_cm3
                )
                await SpoolService(self.db).record_consumption(
                    spool,
                    delta_weight_g=weight_g,
                    event_at=now,
                    source="spoolman_api",
                )
            else:
                logger.warning(
                    "Cannot convert length to weight: missing filament data for spool %s",
                    spool.id,
                )

        spool = await self._get_spool(spool.id)
        return self._spool_to_schema(spool)

    async def measure_spool(
        self, spool_id: int, data: schemas.SpoolMeasureParameters
    ) -> schemas.Spool | None:
        spool = await self._get_spool(spool_id)
        if not spool:
            return None

        now = datetime.now(timezone.utc)
        await SpoolService(self.db).record_measurement(
            spool,
            measured_weight_g=data.weight,
            event_at=now,
            source="spoolman_api",
        )
        spool = await self._get_spool(spool.id)
        return self._spool_to_schema(spool)

    async def list_materials(self) -> list[str]:
        result = await self.db.execute(
            select(Filament.material_type).distinct().order_by(Filament.material_type)
        )
        return [item for item in result.scalars().all() if item]

    async def list_article_numbers(self) -> list[str]:
        result = await self.db.execute(select(Filament.custom_fields))
        article_numbers: set[str] = set()
        for fields in result.scalars().all():
            if not fields:
                continue
            value = fields.get("article_number")
            if value:
                article_numbers.add(value)
        return sorted(article_numbers)

    async def list_lot_numbers(self) -> list[str]:
        result = await self.db.execute(
            select(Spool.lot_number).distinct().order_by(Spool.lot_number)
        )
        return [item for item in result.scalars().all() if item]

    async def list_locations(self) -> list[str]:
        result = await self.db.execute(select(Location.name).order_by(Location.name))
        return [item for item in result.scalars().all() if item]

    async def rename_location(self, old_name: str, new_name: str) -> str | None:
        result = await self.db.execute(
            select(Location).where(func.lower(Location.name) == old_name.lower())
        )
        location = result.scalar_one_or_none()
        if not location:
            return None
        location.name = new_name
        await self.db.commit()
        return location.name

    async def export_spools(self) -> list[dict]:
        result = await self.db.execute(
            select(Spool)
            .options(
                selectinload(Spool.filament).selectinload(Filament.manufacturer),
                selectinload(Spool.status),
                selectinload(Spool.location),
            )
            .order_by(Spool.id)
        )
        spools = result.scalars().unique().all()
        payload: list[dict] = []
        for spool in spools:
            filament = spool.filament
            vendor = filament.manufacturer if filament else None
            payload.append(
                {
                    "id": spool.id,
                    "registered": spool.created_at,
                    "first_used": spool.stocked_in_at,
                    "last_used": spool.last_used_at,
                    "filament_id": spool.filament_id,
                    "filament_name": filament.designation if filament else None,
                    "filament_material": filament.material_type if filament else None,
                    "vendor_id": vendor.id if vendor else None,
                    "vendor_name": vendor.name if vendor else None,
                    "price": spool.purchase_price,
                    "initial_total_weight_g": spool.initial_total_weight_g,
                    "empty_spool_weight_g": spool.empty_spool_weight_g,
                    "remaining_weight_g": spool.remaining_weight_g,
                    "location": spool.location.name if spool.location else None,
                    "lot_number": spool.lot_number,
                    "status": spool.status.key if spool.status else None,
                    "custom_fields": spool.custom_fields,
                }
            )
        return payload

    async def export_filaments(self) -> list[dict]:
        result = await self.db.execute(
            select(Filament)
            .options(
                selectinload(Filament.manufacturer),
                selectinload(Filament.filament_colors).selectinload(
                    FilamentColor.color
                ),
            )
            .order_by(Filament.id)
        )
        filaments = result.scalars().unique().all()
        payload: list[dict] = []
        for filament in filaments:
            vendor = filament.manufacturer
            payload.append(
                {
                    "id": filament.id,
                    "registered": filament.created_at,
                    "name": filament.designation,
                    "vendor_id": vendor.id if vendor else None,
                    "vendor_name": vendor.name if vendor else None,
                    "material": filament.material_type,
                    "price": filament.price,
                    "density": filament.density_g_cm3,
                    "diameter": filament.diameter_mm,
                    "weight": filament.raw_material_weight_g,
                    "spool_weight": filament.default_spool_weight_g,
                    "color_mode": filament.color_mode,
                    "multi_color_style": filament.multi_color_style,
                    "custom_fields": filament.custom_fields,
                }
            )
        return payload

    async def export_vendors(self) -> list[dict]:
        result = await self.db.execute(select(Manufacturer).order_by(Manufacturer.id))
        vendors = result.scalars().all()
        return [
            {
                "id": vendor.id,
                "registered": vendor.created_at,
                "name": vendor.name,
                "empty_spool_weight_g": vendor.empty_spool_weight_g,
                "custom_fields": vendor.custom_fields,
            }
            for vendor in vendors
        ]

    async def get_all_settings(self) -> dict[str, Any]:
        result = await self.db.execute(select(AppSettings).where(AppSettings.id == 1))
        settings_row = result.scalar_one_or_none()
        currency = settings_row.currency if settings_row else "EUR"
        return {
            "currency": {"value": currency, "is_set": True, "type": "string"},
        }

    async def get_setting(self, key: str) -> dict | None:
        settings = await self.get_all_settings()
        return settings.get(key)

    async def set_setting(self, key: str, value: Any) -> dict | None:
        return {"value": value, "is_set": True, "type": "string"}

    async def get_extra_fields(self, entity_type: str) -> list:
        return []

    async def add_extra_field(self, entity_type: str, key: str, data: dict) -> list:
        return []

    async def delete_extra_field(self, entity_type: str, key: str) -> list | None:
        return []

    async def get_external_filaments(self) -> list:
        return []

    async def get_external_materials(self) -> list:
        return []

    async def create_backup(self) -> str:
        return "/data/backups/filaman_backup.db"

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

    async def _find_or_create_color(self, hex_code: str) -> Color:
        try:
            normalized = normalize_hex_color(hex_code)
        except ValueError:
            # The existing compatibility endpoint accepted any string-shaped
            # color value, so only canonicalize values that are valid hex.
            normalized = hex_code.strip().upper()
            if not normalized.startswith("#"):
                normalized = f"#{normalized}"

        result = await self.db.execute(
            select(Color).where(Color.hex_code == normalized)
        )
        color = result.scalar_one_or_none()
        if color:
            return color

        color = Color(name=normalized, hex_code=normalized)
        self.db.add(color)
        await self.db.flush()
        return color

    async def _apply_filament_colors(
        self,
        filament: Filament,
        color_hex: str | None,
        multi_color_hexes: str | None,
        clear_existing: bool = False,
    ) -> None:
        if clear_existing:
            filament.filament_colors.clear()

        if multi_color_hexes:
            hex_list = [
                item.strip() for item in multi_color_hexes.split(",") if item.strip()
            ]
            for index, hex_code in enumerate(hex_list, start=1):
                color = await self._find_or_create_color(hex_code)
                filament.filament_colors.append(
                    FilamentColor(color_id=color.id, position=index)
                )
            filament.color_mode = "multi"
            return

        if color_hex:
            color = await self._find_or_create_color(color_hex)
            filament.filament_colors.append(
                FilamentColor(color_id=color.id, position=1)
            )
        filament.color_mode = "single"

    async def _get_filament(self, filament_id: int) -> Filament | None:
        result = await self.db.execute(
            select(Filament)
            .where(Filament.id == filament_id)
            .options(
                selectinload(Filament.manufacturer),
                selectinload(Filament.filament_colors).selectinload(
                    FilamentColor.color
                ),
            )
        )
        return result.scalar_one_or_none()

    async def _get_manufacturer(self, manufacturer_id: int) -> Manufacturer:
        result = await self.db.execute(
            select(Manufacturer).where(Manufacturer.id == manufacturer_id)
        )
        return result.scalar_one()

    async def _get_spool(self, spool_id: int) -> Spool | None:
        result = await self.db.execute(
            select(Spool)
            .where(Spool.id == spool_id)
            .options(
                selectinload(Spool.filament).selectinload(Filament.manufacturer),
                selectinload(Spool.filament)
                .selectinload(Filament.filament_colors)
                .selectinload(FilamentColor.color),
                selectinload(Spool.status),
                selectinload(Spool.location),
            )
        )
        return result.scalar_one_or_none()

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

    async def _resolve_location(self, name: str | None) -> int | None:
        if not name:
            return None
        result = await self.db.execute(
            select(Location).where(func.lower(Location.name) == name.lower())
        )
        location = result.scalar_one_or_none()
        if location:
            return location.id
        location = Location(name=name)
        self.db.add(location)
        await self.db.flush()
        return location.id

    async def _resolve_status(self, archived: bool) -> int:
        key = "archived" if archived else "new"
        result = await self.db.execute(
            select(SpoolStatus).where(SpoolStatus.key == key)
        )
        status = result.scalar_one()
        return status.id

    def _apply_spool_weights(
        self,
        spool: Spool,
        initial_weight: float | None,
        spool_weight: float | None,
        remaining_weight: float | None,
        used_weight: float | None,
    ) -> None:
        if initial_weight is not None and spool_weight is not None:
            spool.initial_total_weight_g = initial_weight + spool_weight

        if remaining_weight is not None:
            spool.remaining_weight_g = remaining_weight
        elif initial_weight is not None and used_weight is not None:
            spool.remaining_weight_g = initial_weight - used_weight
        elif initial_weight is not None and remaining_weight is None:
            spool.remaining_weight_g = initial_weight

    def _apply_text_filter(
        self, query: Any, column: Any, search_term: str | None
    ) -> Any:
        if search_term is None:
            return query

        terms = self._split_search_terms(search_term)
        if not terms:
            return query

        conditions: list[Any] = []
        for term in terms:
            if term == "":
                conditions.append(or_(column.is_(None), column == ""))
                continue
            if term.startswith('"') and term.endswith('"') and len(term) >= 2:
                raw = term[1:-1]
                conditions.append(func.lower(column) == raw.lower())
                continue
            conditions.append(func.lower(column).like(f"%{term.lower()}%"))

        if conditions:
            query = query.where(or_(*conditions))
        return query

    def _split_search_terms(self, raw: str) -> list[str]:
        terms: list[str] = []
        current: list[str] = []
        in_quotes = False
        for char in raw:
            if char == '"':
                in_quotes = not in_quotes
                current.append(char)
                continue
            if char == "," and not in_quotes:
                terms.append("".join(current).strip())
                current = []
                continue
            current.append(char)
        terms.append("".join(current).strip())
        return [term for term in terms if term is not None]

    def _parse_id_list(self, raw: str) -> tuple[list[int], bool]:
        include_null = False
        ids: list[int] = []
        for item in raw.split(","):
            value = item.strip()
            if not value:
                continue
            if value == "-1":
                include_null = True
                continue
            try:
                ids.append(int(value))
            except ValueError:
                continue
        return ids, include_null

    def _apply_sort(
        self, query: Any, sort: str | None, mapping: dict[str, Any], default_column: Any
    ) -> Any:
        if not sort:
            return query.order_by(default_column)

        order_by: list[Any] = []
        for part in sort.split(","):
            segment = part.strip()
            if not segment:
                continue
            if ":" in segment:
                field, direction = segment.split(":", 1)
            else:
                field, direction = segment, "asc"
            field = field.strip()
            direction = direction.strip().lower()
            column = mapping.get(field)
            if not column:
                continue
            order_by.append(column.desc() if direction == "desc" else column.asc())

        if not order_by:
            return query.order_by(default_column)
        return query.order_by(*order_by)

    def _apply_pagination(self, query: Any, limit: int | None, offset: int) -> Any:
        if offset:
            query = query.offset(offset)
        if limit is not None:
            query = query.limit(limit)
        return query

    async def _count_query(self, query: Any, id_column: Any) -> int:
        base_query = query.order_by(None)
        distinct_ids = (
            base_query.with_only_columns(id_column, maintain_column_froms=True)
            .distinct()
            .subquery()
        )
        result = await self.db.execute(select(func.count()).select_from(distinct_ids))
        return result.scalar_one()
