from sqlalchemy import String
from sqlalchemy.orm import Mapped, mapped_column

from .base import Base, TimestampMixin

class SystemExtraField(Base, TimestampMixin):
    __tablename__ = "system_extra_fields"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    target_type: Mapped[str] = mapped_column(String(50), nullable=False) # "filament" or "spool"
    key: Mapped[str] = mapped_column(String(100), nullable=False)
    label: Mapped[str] = mapped_column(String(200), nullable=False)
    default_value: Mapped[str | None] = mapped_column(String(500), nullable=True)
