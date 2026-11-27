from datetime import date, datetime

from sqlalchemy import Date, Float, Integer, func
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TZDateTime


class InventorySnapshot(Base):
    """Last known stock figures of one day (UTC), the base of the stock charts."""

    __tablename__ = "inventory_snapshots"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    snapshot_date: Mapped[date] = mapped_column(Date, nullable=False, unique=True)
    spool_count: Mapped[int] = mapped_column(Integer, nullable=False)
    total_weight_g: Mapped[float] = mapped_column(Float, nullable=False)
    stock_value: Mapped[float | None] = mapped_column(Float, nullable=True)
    purchase_value: Mapped[float | None] = mapped_column(Float, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        TZDateTime(), server_default=func.now(), nullable=False
    )
