from datetime import datetime
from typing import Any

from sqlalchemy import DateTime, Integer, String, Text, Boolean, JSON, func
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin


class InstalledPlugin(TimestampMixin, Base):
    """Installiertes Plugin (Drucker-Treiber)."""

    __tablename__ = "installed_plugins"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    plugin_key: Mapped[str] = mapped_column(String(50), unique=True, nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    version: Mapped[str] = mapped_column(String(30), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    author: Mapped[str | None] = mapped_column(String(200), nullable=True)
    homepage: Mapped[str | None] = mapped_column(String(500), nullable=True)
    license: Mapped[str | None] = mapped_column(String(100), nullable=True)
    driver_key: Mapped[str] = mapped_column(String(50), nullable=False)
    config_schema: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    installed_at: Mapped[datetime] = mapped_column(
        DateTime, default=func.now(), nullable=False
    )
    installed_by: Mapped[int | None] = mapped_column(Integer, nullable=True)
