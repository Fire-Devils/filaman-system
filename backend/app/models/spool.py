from datetime import datetime
from typing import Any

from sqlalchemy import DateTime, Float, ForeignKey, Integer, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TimestampMixin


class SpoolStatus(Base, TimestampMixin):
    __tablename__ = "spool_statuses"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    key: Mapped[str] = mapped_column(String(50), nullable=False, unique=True)
    label: Mapped[str] = mapped_column(String(100), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    sort_order: Mapped[int] = mapped_column(Integer, default=0)
    is_system: Mapped[bool] = mapped_column(default=False)

    spools: Mapped[list["Spool"]] = relationship(back_populates="status")
    events_from: Mapped[list["SpoolEvent"]] = relationship(back_populates="from_status", foreign_keys="[SpoolEvent.from_status_id]")
    events_to: Mapped[list["SpoolEvent"]] = relationship(back_populates="to_status", foreign_keys="[SpoolEvent.to_status_id]")


class Spool(Base, TimestampMixin):
    __tablename__ = "spools"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    filament_id: Mapped[int] = mapped_column(Integer, ForeignKey("filaments.id"), nullable=False)
    status_id: Mapped[int] = mapped_column(Integer, ForeignKey("spool_statuses.id"), nullable=False)

    lot_number: Mapped[str | None] = mapped_column(String(100), nullable=True)

    rfid_uid: Mapped[str | None] = mapped_column(String(100), nullable=True, unique=True)
    external_id: Mapped[str | None] = mapped_column(String(100), nullable=True, unique=True)

    location_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("locations.id"), nullable=True)

    purchase_date: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    expiration_date: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    purchase_price: Mapped[float | None] = mapped_column(Float, nullable=True)

    stocked_in_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    initial_total_weight_g: Mapped[float | None] = mapped_column(Float, nullable=True)
    empty_spool_weight_g: Mapped[float | None] = mapped_column(Float, nullable=True)
    remaining_weight_g: Mapped[float | None] = mapped_column(Float, nullable=True)

    spool_outer_diameter_mm: Mapped[float | None] = mapped_column(Float, nullable=True)
    spool_width_mm: Mapped[float | None] = mapped_column(Float, nullable=True)

    low_weight_threshold_g: Mapped[int] = mapped_column(Integer, nullable=False, default=100)

    deleted_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    custom_fields: Mapped[dict[str, Any] | None] = mapped_column(nullable=True)

    filament: Mapped["Filament"] = relationship(back_populates="spools")
    status: Mapped["SpoolStatus"] = relationship(back_populates="spools")
    location: Mapped["Location"] = relationship(back_populates="spools")
    events: Mapped[list["SpoolEvent"]] = relationship(back_populates="spool", cascade="all, delete-orphan")
    slot_assignments: Mapped[list["PrinterSlotAssignment"]] = relationship(back_populates="spool")
    slot_events: Mapped[list["PrinterSlotEvent"]] = relationship(back_populates="spool")


class SpoolEvent(Base):
    __tablename__ = "spool_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    spool_id: Mapped[int] = mapped_column(Integer, ForeignKey("spools.id", ondelete="CASCADE"), nullable=False)

    event_type: Mapped[str] = mapped_column(String(50), nullable=False)
    event_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)

    user_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("users.id"), nullable=True)
    device_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("devices.id"), nullable=True)

    source: Mapped[str | None] = mapped_column(String(50), nullable=True)
    delta_weight_g: Mapped[float | None] = mapped_column(Float, nullable=True)
    measured_weight_g: Mapped[float | None] = mapped_column(Float, nullable=True)

    from_status_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("spool_statuses.id"), nullable=True)
    to_status_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("spool_statuses.id"), nullable=True)
    from_location_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("locations.id"), nullable=True)
    to_location_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("locations.id"), nullable=True)

    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    meta: Mapped[dict[str, Any] | None] = mapped_column(nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=func.now(), nullable=False)

    spool: Mapped["Spool"] = relationship(back_populates="events")
    user: Mapped["User"] = relationship(back_populates="spool_events")
    device: Mapped["Device"] = relationship(back_populates="spool_events")
    from_status: Mapped["SpoolStatus"] = relationship(back_populates="events_from", foreign_keys=[from_status_id])
    to_status: Mapped["SpoolStatus"] = relationship(back_populates="events_to", foreign_keys=[to_status_id])
    from_location: Mapped["Location"] = relationship(back_populates="events_from", foreign_keys=[from_location_id])
    to_location: Mapped["Location"] = relationship(back_populates="events_to", foreign_keys=[to_location_id])


from app.models.filament import Filament
from app.models.user import User
from app.models.device import Device
from app.models.location import Location
from app.models.printer import PrinterSlotAssignment, PrinterSlotEvent
