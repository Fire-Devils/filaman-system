"""Lokaler Stand der an die FilaMan-DB gesendeten Beiträge."""

from datetime import datetime
from typing import Any

from sqlalchemy import JSON, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin, TZDateTime

ENTITY_TYPES = ("manufacturer", "filament", "printer_model", "print_profile")
STATUSES = (
    "draft",
    "waiting",
    "pending",
    "approved",
    "rejected",
    "changes_requested",
    "published",
    "linked",
    "error",
)


class FilamentDBContribution(Base, TimestampMixin):
    """Ein Beitrag je lokalem Objekt (Typ + lokale ID); erneutes Senden nutzt dieselbe Zeile."""

    __tablename__ = "filamentdb_contributions"
    __table_args__ = (
        UniqueConstraint("entity_type", "local_id", name="uq_filamentdb_contrib_entity"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    entity_type: Mapped[str] = mapped_column(String(30), nullable=False, index=True)
    local_id: Mapped[int] = mapped_column(Integer, nullable=False)
    remote_submission_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    remote_entity_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    status: Mapped[str] = mapped_column(String(30), nullable=False, default="draft", index=True)
    depends_on_id: Mapped[int | None] = mapped_column(
        Integer, ForeignKey("filamentdb_contributions.id", ondelete="SET NULL"), nullable=True
    )
    payload: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
    last_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    last_checked_at: Mapped[datetime | None] = mapped_column(TZDateTime(), nullable=True)
    created_by: Mapped[int | None] = mapped_column(
        Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
