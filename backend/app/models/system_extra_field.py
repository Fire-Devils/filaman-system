from typing import Any

from sqlalchemy import JSON, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from .base import Base, TimestampMixin


class SystemExtraField(Base, TimestampMixin):
    __tablename__ = "system_extra_fields"

    __table_args__ = (
        UniqueConstraint("target_type", "key", name="uq_system_extra_fields_target_key"),
    )

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    target_type: Mapped[str] = mapped_column(String(50), nullable=False)  # "filament" or "spool"
    key: Mapped[str] = mapped_column(String(100), nullable=False)
    label: Mapped[str] = mapped_column(String(200), nullable=False)
    default_value: Mapped[str | None] = mapped_column(String(500), nullable=True)
    field_type: Mapped[str] = mapped_column(String(30), nullable=False, default="text")  # text, number, dropdown, checkbox
    options: Mapped[list[str] | None] = mapped_column(JSON, nullable=True)  # dropdown options
    source: Mapped[str | None] = mapped_column(String(100), nullable=True)  # plugin ownership, e.g. "bambulab"
