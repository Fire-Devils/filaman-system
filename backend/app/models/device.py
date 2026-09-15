from datetime import datetime, timezone
from typing import Any

from sqlalchemy import Boolean, Integer, String, Text, func, text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TimestampMixin, TZDateTime


class Device(Base, TimestampMixin):
    __tablename__ = "devices"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    device_type: Mapped[str] = mapped_column(String(50), nullable=False)
    device_code: Mapped[str | None] = mapped_column(String(6), unique=True, nullable=True, index=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)

    token_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    scopes: Mapped[list[str] | None] = mapped_column(nullable=True)

    last_used_at: Mapped[datetime | None] = mapped_column(TZDateTime(), nullable=True)
    last_seen_at: Mapped[datetime | None] = mapped_column(TZDateTime(), nullable=True)
    ip_address: Mapped[str | None] = mapped_column(String(45), nullable=True)
    is_active: Mapped[bool] = mapped_column(default=True)
    deleted_at: Mapped[datetime | None] = mapped_column(TZDateTime(), nullable=True)

    auto_assign_enabled: Mapped[bool] = mapped_column(Boolean, default=False, server_default=text('false'))
    auto_assign_timeout: Mapped[int] = mapped_column(Integer, default=60, server_default="60")

    custom_fields: Mapped[dict[str, Any] | None] = mapped_column(nullable=True)
    
    @property
    def is_online(self) -> bool:
        if not self.last_seen_at:
            return False
        delta = datetime.now(timezone.utc) - self.last_seen_at
        return delta.total_seconds() < 180  # 3 minutes

    @property
    def registration_pending(self) -> bool:
        return not self.is_active and self.device_code is not None

    spool_events: Mapped[list["SpoolEvent"]] = relationship(back_populates="device")



from app.models.spool import SpoolEvent
