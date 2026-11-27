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
    rfid_display_colons: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    default_spool_core_weight_g: Mapped[float | None] = mapped_column(Float, nullable=True)
    default_empty_spool_weight_g: Mapped[float | None] = mapped_column(Float, nullable=True)
    # "Spool full" (scale): nominal filament weight fallback and plausibility
    # window for the derived empty-spool weight.
    spool_full_nominal_weight_g: Mapped[float] = mapped_column(
        Float, default=1000.0, server_default="1000", nullable=False
    )
    spool_full_tara_min_g: Mapped[float] = mapped_column(
        Float, default=100.0, server_default="100", nullable=False
    )
    spool_full_tara_max_g: Mapped[float] = mapped_column(
        Float, default=350.0, server_default="350", nullable=False
    )
    spool_full_overwrite_threshold_g: Mapped[float] = mapped_column(
        Float, default=5.0, server_default="5", nullable=False
    )
    # Fallback when no slicer profile resolves for a filament/model: "generic"
    # (Generic <material>) or "bambu" (Bambu-brand basic profile for the material).
    bambu_unmatched_profile_fallback: Mapped[str] = mapped_column(
        String(20), default="generic", nullable=False
    )
    filament_lookup_source: Mapped[str] = mapped_column(
        String(20), default="filamandb", nullable=False
    )
    # MCP server (/mcp) for AI assistants. Off by default; write tools need a
    # second, separate opt-in.
    mcp_enabled: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    mcp_write_enabled: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    # Periodically import new ESP firmware images from GitHub releases.
    firmware_auto_import: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    # Keep only the current and the latest other ESP firmware per project.
    firmware_keep_latest_only: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
