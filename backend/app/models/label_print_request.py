from datetime import datetime

from sqlalchemy import ForeignKey, Integer, func
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TZDateTime


class LabelPrintRequest(Base):
    __tablename__ = "label_print_requests"
    __table_args__ = ({"sqlite_autoincrement": True},)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    spool_id: Mapped[int] = mapped_column(Integer, ForeignKey("spools.id", ondelete="CASCADE"), nullable=False)
    user_id: Mapped[int] = mapped_column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    preset_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("label_presets.id", ondelete="CASCADE"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(TZDateTime(), server_default=func.now(), nullable=False)
