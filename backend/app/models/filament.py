from datetime import datetime
from typing import Any

from sqlalchemy import DateTime, Float, ForeignKey, Integer, String, Text, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TimestampMixin


class Manufacturer(Base, TimestampMixin):
    __tablename__ = "manufacturers"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False, unique=True, index=True)
    url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    
    empty_spool_weight_g: Mapped[float | None] = mapped_column(Float, nullable=True)
    spool_outer_diameter_mm: Mapped[float | None] = mapped_column(Float, nullable=True)
    spool_width_mm: Mapped[float | None] = mapped_column(Float, nullable=True)
    spool_material: Mapped[str | None] = mapped_column(String(100), nullable=True)

    custom_fields: Mapped[dict[str, Any] | None] = mapped_column(nullable=True)

    filaments: Mapped[list["Filament"]] = relationship(back_populates="manufacturer")


class Color(Base, TimestampMixin):
    __tablename__ = "colors"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    hex_code: Mapped[str] = mapped_column(String(7), nullable=False)
    custom_fields: Mapped[dict[str, Any] | None] = mapped_column(nullable=True)

    __table_args__ = (UniqueConstraint("name", "hex_code", name="uq_colors_name_hex"),)

    filament_colors: Mapped[list["FilamentColor"]] = relationship(back_populates="color")


class Filament(Base, TimestampMixin):
    __tablename__ = "filaments"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    manufacturer_id: Mapped[int] = mapped_column(Integer, ForeignKey("manufacturers.id"), nullable=False, index=True)

    designation: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    type: Mapped[str] = mapped_column(String(50), nullable=False, index=True)
    material_subgroup: Mapped[str | None] = mapped_column(String(100), nullable=True, index=True)
    diameter_mm: Mapped[float] = mapped_column(Float, nullable=False)

    manufacturer_color_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    finish_type: Mapped[str | None] = mapped_column(String(50), nullable=True)

    raw_material_weight_g: Mapped[float | None] = mapped_column(Float, nullable=True)
    default_spool_weight_g: Mapped[float | None] = mapped_column(Float, nullable=True)
    spool_outer_diameter_mm: Mapped[float | None] = mapped_column(Float, nullable=True)
    spool_width_mm: Mapped[float | None] = mapped_column(Float, nullable=True)
    spool_material: Mapped[str | None] = mapped_column(String(100), nullable=True)

    price: Mapped[float | None] = mapped_column(Float, nullable=True)
    shop_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    density_g_cm3: Mapped[float | None] = mapped_column(Float, nullable=True)

    color_mode: Mapped[str] = mapped_column(String(20), nullable=False, default="single")
    multi_color_style: Mapped[str | None] = mapped_column(String(20), nullable=True)

    custom_fields: Mapped[dict[str, Any] | None] = mapped_column(nullable=True)

    manufacturer: Mapped["Manufacturer"] = relationship(back_populates="filaments")
    filament_colors: Mapped[list["FilamentColor"]] = relationship(back_populates="filament", cascade="all, delete-orphan")
    spools: Mapped[list["Spool"]] = relationship(back_populates="filament")
    printer_profiles: Mapped[list["FilamentPrinterProfile"]] = relationship(back_populates="filament", cascade="all, delete-orphan")
    ratings: Mapped[list["FilamentRating"]] = relationship(back_populates="filament", cascade="all, delete-orphan")


class FilamentColor(Base):
    __tablename__ = "filament_colors"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    filament_id: Mapped[int] = mapped_column(Integer, ForeignKey("filaments.id", ondelete="CASCADE"), nullable=False, index=True)
    color_id: Mapped[int] = mapped_column(Integer, ForeignKey("colors.id"), nullable=False, index=True)
    position: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    display_name_override: Mapped[str | None] = mapped_column(String(100), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=func.now(), nullable=False)

    __table_args__ = (UniqueConstraint("filament_id", "position", name="uq_filament_colors_filament_position"),)

    filament: Mapped["Filament"] = relationship(back_populates="filament_colors")
    color: Mapped["Color"] = relationship(back_populates="filament_colors")


class FilamentRating(Base, TimestampMixin):
    __tablename__ = "filament_ratings"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    filament_id: Mapped[int] = mapped_column(Integer, ForeignKey("filaments.id", ondelete="CASCADE"), nullable=False)
    user_id: Mapped[int] = mapped_column(Integer, ForeignKey("users.id"), nullable=False)
    stars: Mapped[int] = mapped_column(Integer, nullable=False)
    title: Mapped[str | None] = mapped_column(String(255), nullable=True)
    comment: Mapped[str | None] = mapped_column(Text, nullable=True)

    __table_args__ = (UniqueConstraint("filament_id", "user_id", name="uq_filament_ratings_filament_user"),)

    filament: Mapped["Filament"] = relationship(back_populates="ratings")
    user: Mapped["User"] = relationship(back_populates="filament_ratings")


class FilamentPrinterProfile(Base, TimestampMixin):
    __tablename__ = "filament_printer_profiles"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    filament_id: Mapped[int] = mapped_column(Integer, ForeignKey("filaments.id", ondelete="CASCADE"), nullable=False)
    printer_id: Mapped[int] = mapped_column(Integer, ForeignKey("printers.id"), nullable=False)
    profile_name: Mapped[str] = mapped_column(String(255), nullable=False)

    is_default_for_printer: Mapped[bool] = mapped_column(default=False)

    nozzle_diameter_mm: Mapped[float | None] = mapped_column(Float, nullable=True)
    extruder_type: Mapped[str | None] = mapped_column(String(50), nullable=True)

    nozzle_temp_c: Mapped[int | None] = mapped_column(Integer, nullable=True)
    bed_temp_c: Mapped[int | None] = mapped_column(Integer, nullable=True)
    chamber_temp_c: Mapped[int | None] = mapped_column(Integer, nullable=True)

    print_speed_mm_s: Mapped[int | None] = mapped_column(Integer, nullable=True)
    travel_speed_mm_s: Mapped[int | None] = mapped_column(Integer, nullable=True)
    first_layer_speed_mm_s: Mapped[int | None] = mapped_column(Integer, nullable=True)
    max_volumetric_flow_mm3_s: Mapped[float | None] = mapped_column(Float, nullable=True)

    flowrate_percent: Mapped[int | None] = mapped_column(Integer, nullable=True)
    extrusion_multiplier: Mapped[float | None] = mapped_column(Float, nullable=True)
    pressure_advance_k: Mapped[float | None] = mapped_column(Float, nullable=True)
    linear_advance_k: Mapped[float | None] = mapped_column(Float, nullable=True)

    retraction_mm: Mapped[float | None] = mapped_column(Float, nullable=True)
    retraction_speed_mm_s: Mapped[int | None] = mapped_column(Integer, nullable=True)
    deretraction_speed_mm_s: Mapped[int | None] = mapped_column(Integer, nullable=True)
    retraction_extra_prime_mm3: Mapped[float | None] = mapped_column(Float, nullable=True)

    fan_percent_min: Mapped[int | None] = mapped_column(Integer, nullable=True)
    fan_percent_max: Mapped[int | None] = mapped_column(Integer, nullable=True)
    fan_first_layer_percent: Mapped[int | None] = mapped_column(Integer, nullable=True)

    z_hop_mm: Mapped[float | None] = mapped_column(Float, nullable=True)
    z_hop_only_when_retracting: Mapped[bool | None] = mapped_column(nullable=True)
    bridge_flow_percent: Mapped[int | None] = mapped_column(Integer, nullable=True)
    bridge_fan_percent: Mapped[int | None] = mapped_column(Integer, nullable=True)

    material_notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    custom_fields: Mapped[dict[str, Any] | None] = mapped_column(nullable=True)

    filament: Mapped["Filament"] = relationship(back_populates="printer_profiles")
    printer: Mapped["Printer"] = relationship(back_populates="filament_profiles")


from app.models.spool import Spool
from app.models.user import User
from app.models.printer import Printer
