from sqlalchemy import ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .base import Base, TimestampMixin


class FilamentPrinterParam(Base, TimestampMixin):
    """Per-printer calibration parameters for a filament (e.g. bambu_k, bambu_flow_ratio)."""
    __tablename__ = "filament_printer_params"

    __table_args__ = (
        UniqueConstraint("filament_id", "printer_id", "param_key", name="uq_filament_printer_params"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    filament_id: Mapped[int] = mapped_column(Integer, ForeignKey("filaments.id", ondelete="CASCADE"), nullable=False, index=True)
    printer_id: Mapped[int] = mapped_column(Integer, ForeignKey("printers.id", ondelete="CASCADE"), nullable=False, index=True)
    param_key: Mapped[str] = mapped_column(String(100), nullable=False)
    param_value: Mapped[str | None] = mapped_column(String(500), nullable=True)

    filament: Mapped["Filament"] = relationship(back_populates="printer_params")
    printer: Mapped["Printer"] = relationship(back_populates="filament_params")


class SpoolPrinterParam(Base, TimestampMixin):
    """Per-printer calibration parameters for a spool (overrides filament-level values)."""
    __tablename__ = "spool_printer_params"

    __table_args__ = (
        UniqueConstraint("spool_id", "printer_id", "param_key", name="uq_spool_printer_params"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    spool_id: Mapped[int] = mapped_column(Integer, ForeignKey("spools.id", ondelete="CASCADE"), nullable=False, index=True)
    printer_id: Mapped[int] = mapped_column(Integer, ForeignKey("printers.id", ondelete="CASCADE"), nullable=False, index=True)
    param_key: Mapped[str] = mapped_column(String(100), nullable=False)
    param_value: Mapped[str | None] = mapped_column(String(500), nullable=True)

    spool: Mapped["Spool"] = relationship(back_populates="printer_params")
    printer: Mapped["Printer"] = relationship(back_populates="spool_params")


from app.models.filament import Filament
from app.models.spool import Spool
from app.models.printer import Printer
