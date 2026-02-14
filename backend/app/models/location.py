from datetime import datetime
from typing import Any

from sqlalchemy import DateTime, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TimestampMixin


class Location(Base, TimestampMixin):
    __tablename__ = "locations"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    identifier: Mapped[str | None] = mapped_column(String(100), nullable=True)
    custom_fields: Mapped[dict[str, Any] | None] = mapped_column(nullable=True)

    spools: Mapped[list["Spool"]] = relationship(back_populates="location")
    printers: Mapped[list["Printer"]] = relationship(back_populates="location")
    events_from: Mapped[list["SpoolEvent"]] = relationship(back_populates="from_location", foreign_keys="[SpoolEvent.from_location_id]")
    events_to: Mapped[list["SpoolEvent"]] = relationship(back_populates="to_location", foreign_keys="[SpoolEvent.to_location_id]")


from app.models.spool import Spool, SpoolEvent
from app.models.printer import Printer
