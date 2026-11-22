from typing import Any

from sqlalchemy import JSON, Float, ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin


class SpoolLinkSuggestion(Base, TimestampMixin):
    """An unknown external tag that probably belongs to an existing sealed spool."""

    __tablename__ = "spool_link_suggestions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    external_id: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    filament_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("filaments.id", ondelete="CASCADE"), nullable=False
    )
    source: Mapped[str] = mapped_column(String(50), nullable=False)
    printer_id: Mapped[int | None] = mapped_column(
        Integer, ForeignKey("printers.id", ondelete="SET NULL"), nullable=True
    )
    slot_label: Mapped[str | None] = mapped_column(String(100), nullable=True)
    tag_data: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
    remaining_weight_g: Mapped[float | None] = mapped_column(Float, nullable=True)
    status: Mapped[str] = mapped_column(
        String(20), nullable=False, default="pending", server_default="pending"
    )
    linked_spool_id: Mapped[int | None] = mapped_column(
        Integer, ForeignKey("spools.id", ondelete="SET NULL"), nullable=True
    )
