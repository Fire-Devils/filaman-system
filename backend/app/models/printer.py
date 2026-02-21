from datetime import datetime
from typing import Any

from sqlalchemy import Boolean, DateTime, Float, ForeignKey, Integer, String, Text, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TimestampMixin


class Printer(Base, TimestampMixin):
    __tablename__ = "printers"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    manufacturer: Mapped[str | None] = mapped_column(String(100), nullable=True)
    model: Mapped[str | None] = mapped_column(String(100), nullable=True)
    serial_number: Mapped[str | None] = mapped_column(String(100), nullable=True)

    location_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("locations.id"), nullable=True)
    is_active: Mapped[bool] = mapped_column(default=True)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    driver_key: Mapped[str] = mapped_column(String(100), nullable=False)
    driver_config: Mapped[dict[str, Any] | None] = mapped_column(nullable=True)

    custom_fields: Mapped[dict[str, Any] | None] = mapped_column(nullable=True)

    location: Mapped["Location"] = relationship(back_populates="printers")
    ams_units: Mapped[list["PrinterAmsUnit"]] = relationship(back_populates="printer", cascade="all, delete-orphan")
    slots: Mapped[list["PrinterSlot"]] = relationship(back_populates="printer", cascade="all, delete-orphan")
    slot_events: Mapped[list["PrinterSlotEvent"]] = relationship(back_populates="printer", cascade="all, delete-orphan")
    filament_profiles: Mapped[list["FilamentPrinterProfile"]] = relationship(back_populates="printer")


class PrinterAmsUnit(Base, TimestampMixin):
    __tablename__ = "printer_ams_units"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    printer_id: Mapped[int] = mapped_column(Integer, ForeignKey("printers.id", ondelete="CASCADE"), nullable=False)
    ams_unit_no: Mapped[int] = mapped_column(Integer, nullable=False)
    name: Mapped[str | None] = mapped_column(String(100), nullable=True)
    slots_total: Mapped[int] = mapped_column(Integer, nullable=False)
    is_active: Mapped[bool] = mapped_column(default=True)
    custom_fields: Mapped[dict[str, Any] | None] = mapped_column(nullable=True)

    __table_args__ = (UniqueConstraint("printer_id", "ams_unit_no", name="uq_printer_ams_units_printer_unit"),)

    printer: Mapped["Printer"] = relationship(back_populates="ams_units")
    slots: Mapped[list["PrinterSlot"]] = relationship(back_populates="ams_unit")


class PrinterSlot(Base, TimestampMixin):
    __tablename__ = "printer_slots"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    printer_id: Mapped[int] = mapped_column(Integer, ForeignKey("printers.id", ondelete="CASCADE"), nullable=False, index=True)

    is_ams_slot: Mapped[bool] = mapped_column(nullable=False)
    ams_unit_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("printer_ams_units.id", ondelete="SET NULL"), nullable=True, index=True)
    slot_no: Mapped[int] = mapped_column(Integer, nullable=False)

    name: Mapped[str | None] = mapped_column(String(100), nullable=True)
    is_active: Mapped[bool] = mapped_column(default=True)

    custom_fields: Mapped[dict[str, Any] | None] = mapped_column(nullable=True)

    __table_args__ = (UniqueConstraint("printer_id", "is_ams_slot", "ams_unit_id", "slot_no", name="uq_printer_slots_unique"),)

    printer: Mapped["Printer"] = relationship(back_populates="slots")
    ams_unit: Mapped["PrinterAmsUnit"] = relationship(back_populates="slots")
    assignment: Mapped["PrinterSlotAssignment"] = relationship(back_populates="slot", uselist=False, cascade="all, delete-orphan")
    events: Mapped[list["PrinterSlotEvent"]] = relationship(back_populates="slot", cascade="all, delete-orphan")


class PrinterSlotAssignment(Base):
    __tablename__ = "printer_slot_assignments"

    slot_id: Mapped[int] = mapped_column(Integer, ForeignKey("printer_slots.id", ondelete="CASCADE"), primary_key=True)

    spool_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("spools.id", ondelete="SET NULL"), nullable=True, index=True)

    present: Mapped[bool] = mapped_column(nullable=False, default=False)

    rfid_uid: Mapped[str | None] = mapped_column(String(100), nullable=True)
    external_id: Mapped[str | None] = mapped_column(String(100), nullable=True)

    inserted_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=func.now(), onupdate=func.now(), nullable=False)

    meta: Mapped[dict[str, Any] | None] = mapped_column(nullable=True)

    slot: Mapped["PrinterSlot"] = relationship(back_populates="assignment")
    spool: Mapped["Spool"] = relationship(back_populates="slot_assignments")


class PrinterSlotEvent(Base):
    __tablename__ = "printer_slot_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    printer_id: Mapped[int] = mapped_column(Integer, ForeignKey("printers.id", ondelete="CASCADE"), nullable=False)
    slot_id: Mapped[int] = mapped_column(Integer, ForeignKey("printer_slots.id", ondelete="CASCADE"), nullable=False)

    event_type: Mapped[str] = mapped_column(String(50), nullable=False)
    event_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)

    spool_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("spools.id", ondelete="SET NULL"), nullable=True)
    rfid_uid: Mapped[str | None] = mapped_column(String(100), nullable=True)
    external_id: Mapped[str | None] = mapped_column(String(100), nullable=True)

    meta: Mapped[dict[str, Any] | None] = mapped_column(nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=func.now(), nullable=False)

    printer: Mapped["Printer"] = relationship(back_populates="slot_events")
    slot: Mapped["PrinterSlot"] = relationship(back_populates="events")
    spool: Mapped["Spool"] = relationship(back_populates="slot_events")


from app.models.location import Location
from app.models.spool import Spool
from app.models.filament import FilamentPrinterProfile
