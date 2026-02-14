from datetime import datetime
from typing import Any

from sqlalchemy import Boolean, DateTime, Integer, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TimestampMixin


class Device(Base, TimestampMixin):
    __tablename__ = "devices"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    device_type: Mapped[str] = mapped_column(String(50), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)

    token_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    scopes: Mapped[list[str] | None] = mapped_column(nullable=True)

    last_used_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    is_active: Mapped[bool] = mapped_column(default=True)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    custom_fields: Mapped[dict[str, Any] | None] = mapped_column(nullable=True)

    spool_events: Mapped[list["SpoolEvent"]] = relationship(back_populates="device")


from app.models.spool import SpoolEvent
