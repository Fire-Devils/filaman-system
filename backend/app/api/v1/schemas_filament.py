from typing import Any

from pydantic import BaseModel


class ManufacturerCreate(BaseModel):
    name: str
    url: str | None = None
    custom_fields: dict[str, Any] | None = None


class ManufacturerUpdate(BaseModel):
    name: str | None = None
    url: str | None = None
    custom_fields: dict[str, Any] | None = None


class ManufacturerResponse(BaseModel):
    id: int
    name: str
    url: str | None
    custom_fields: dict[str, Any] | None

    class Config:
        from_attributes = True


class ColorCreate(BaseModel):
    name: str
    hex_code: str
    custom_fields: dict[str, Any] | None = None


class ColorUpdate(BaseModel):
    name: str | None = None
    hex_code: str | None = None
    custom_fields: dict[str, Any] | None = None


class ColorResponse(BaseModel):
    id: int
    name: str
    hex_code: str
    custom_fields: dict[str, Any] | None

    class Config:
        from_attributes = True


class FilamentCreate(BaseModel):
    manufacturer_id: int
    designation: str
    type: str
    material_subgroup: str | None = None
    diameter_mm: float
    manufacturer_color_name: str | None = None
    finish_type: str | None = None
    raw_material_weight_g: float | None = None
    default_spool_weight_g: float | None = None
    price: float | None = None
    shop_url: str | None = None
    density_g_cm3: float | None = None
    color_mode: str = "single"
    multi_color_style: str | None = None
    custom_fields: dict[str, Any] | None = None


class FilamentUpdate(BaseModel):
    manufacturer_id: int | None = None
    designation: str | None = None
    type: str | None = None
    material_subgroup: str | None = None
    diameter_mm: float | None = None
    manufacturer_color_name: str | None = None
    finish_type: str | None = None
    raw_material_weight_g: float | None = None
    default_spool_weight_g: float | None = None
    price: float | None = None
    shop_url: str | None = None
    density_g_cm3: float | None = None
    color_mode: str | None = None
    multi_color_style: str | None = None
    custom_fields: dict[str, Any] | None = None


class FilamentResponse(BaseModel):
    id: int
    manufacturer_id: int
    designation: str
    type: str
    material_subgroup: str | None
    diameter_mm: float
    manufacturer_color_name: str | None
    finish_type: str | None
    raw_material_weight_g: float | None
    default_spool_weight_g: float | None
    price: float | None
    shop_url: str | None
    density_g_cm3: float | None
    color_mode: str
    multi_color_style: str | None
    custom_fields: dict[str, Any] | None

    class Config:
        from_attributes = True


class FilamentDetailResponse(FilamentResponse):
    manufacturer: ManufacturerResponse | None = None
