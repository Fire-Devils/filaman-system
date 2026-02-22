from typing import Any

from pydantic import BaseModel, Field


class ManufacturerCreate(BaseModel):
    name: str
    url: str | None = None
    empty_spool_weight_g: float | None = None
    spool_outer_diameter_mm: float | None = None
    spool_width_mm: float | None = None
    spool_material: str | None = None
    custom_fields: dict[str, Any] | None = None


class ManufacturerUpdate(BaseModel):
    name: str | None = None
    url: str | None = None
    empty_spool_weight_g: float | None = None
    spool_outer_diameter_mm: float | None = None
    spool_width_mm: float | None = None
    spool_material: str | None = None
    custom_fields: dict[str, Any] | None = None


class ManufacturerResponse(BaseModel):
    id: int
    name: str
    url: str | None
    empty_spool_weight_g: float | None = None
    spool_outer_diameter_mm: float | None = None
    spool_width_mm: float | None = None
    spool_material: str | None = None
    custom_fields: dict[str, Any] | None
    filament_count: int = 0
    spool_count: int = 0
    archived_spool_count: int = 0
    total_price_available: float = 0.0
    total_price_all: float = 0.0
    materials: list[str] = []

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
    custom_fields: dict[str, Any] | None = None
    usage_count: int = 0

    class Config:

        from_attributes = True


class FilamentColorEntry(BaseModel):
    """A single color assignment for a filament (used in create/replace)."""
    color_id: int
    position: int = 1
    display_name_override: str | None = None


class FilamentColorResponse(BaseModel):
    """Color entry as returned by the API."""
    id: int
    color_id: int
    position: int
    display_name_override: str | None
    color: ColorResponse | None = None

    class Config:
        from_attributes = True


class FilamentColorsReplace(BaseModel):
    """Body for PUT /filaments/{id}/colors."""
    color_mode: str = Field(..., pattern="^(single|multi)$")
    multi_color_style: str | None = Field(None, pattern="^(striped|gradient)$")
    colors: list[FilamentColorEntry] = []


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
    spool_outer_diameter_mm: float | None = None
    spool_width_mm: float | None = None
    spool_material: str | None = None
    price: float | None = None
    shop_url: str | None = None
    density_g_cm3: float | None = None
    color_mode: str = "single"
    multi_color_style: str | None = None
    custom_fields: dict[str, Any] | None = None
    colors: list[FilamentColorEntry] | None = None


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
    spool_outer_diameter_mm: float | None = None
    spool_width_mm: float | None = None
    spool_material: str | None = None
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
    spool_outer_diameter_mm: float | None = None
    spool_width_mm: float | None = None
    spool_material: str | None = None
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
    spool_count: int = 0
    colors: list[FilamentColorResponse] = []
