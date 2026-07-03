"""AppSettings model for global application configuration."""

from sqlalchemy import Boolean, Float, String
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin


class AppSettings(Base, TimestampMixin):
    """Single-row table storing global application settings.

    Only one row (id=1) is expected. The application upserts this row
    whenever a setting is modified.
    """

    __tablename__ = "app_settings"

    id: Mapped[int] = mapped_column(autoincrement=True, primary_key=True)
    login_disabled: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    currency: Mapped[str] = mapped_column(String(3), default="EUR", nullable=False)
    rfid_extended_data_enabled: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    rfid_protocol: Mapped[str] = mapped_column(String(20), default="openspool", nullable=False)
    default_spool_core_weight_g: Mapped[float | None] = mapped_column(Float, nullable=True)
    # Fallback when no slicer profile resolves for a filament/model: "generic"
    # (Generic <material>) or "bambu" (Bambu-brand basic profile for the material).
    bambu_unmatched_profile_fallback: Mapped[str] = mapped_column(
        String(20), default="generic", nullable=False
    )
