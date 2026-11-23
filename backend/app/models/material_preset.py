"""MaterialPreset model: default values per filament material."""

from sqlalchemy import Float, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin


class MaterialPreset(Base, TimestampMixin):
    __tablename__ = "material_presets"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    material_type: Mapped[str] = mapped_column(String(50), nullable=False, unique=True)

    extruder_temp_min_c: Mapped[float | None] = mapped_column(Float, nullable=True)
    extruder_temp_max_c: Mapped[float | None] = mapped_column(Float, nullable=True)
    bed_temp_min_c: Mapped[float | None] = mapped_column(Float, nullable=True)
    bed_temp_max_c: Mapped[float | None] = mapped_column(Float, nullable=True)
    flow_ratio: Mapped[float | None] = mapped_column(Float, nullable=True)
    drying_temp_c: Mapped[float | None] = mapped_column(Float, nullable=True)
    drying_time_hours: Mapped[float | None] = mapped_column(Float, nullable=True)
    drying_interval_days: Mapped[int | None] = mapped_column(Integer, nullable=True)
    density_g_cm3: Mapped[float | None] = mapped_column(Float, nullable=True)
