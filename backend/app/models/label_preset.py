import hashlib
from typing import TYPE_CHECKING, Any

from sqlalchemy import CheckConstraint, ForeignKey, Index, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TimestampMixin

if TYPE_CHECKING:
    from app.models.user import User

LABEL_PRESET_NAME_MAX_LENGTH = 120


def normalize_label_preset_name(name: str) -> str:
    normalized = name.strip()
    if not normalized:
        raise ValueError("Preset name cannot be empty")
    if len(normalized) > LABEL_PRESET_NAME_MAX_LENGTH:
        raise ValueError(
            f"Preset name cannot exceed {LABEL_PRESET_NAME_MAX_LENGTH} characters"
        )
    if not normalized.isprintable():
        raise ValueError("Preset name cannot contain control characters")
    return normalized


def label_preset_name_key(name: str) -> str:
    """Return a collation-independent key while preserving exact-name semantics."""
    return hashlib.sha256(name.encode("utf-8")).hexdigest()


class LabelPreset(Base, TimestampMixin):
    __tablename__ = "label_presets"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    preset_type: Mapped[str] = mapped_column(String(20), nullable=False)
    name: Mapped[str] = mapped_column(
        String(LABEL_PRESET_NAME_MAX_LENGTH), nullable=False
    )
    name_key: Mapped[str] = mapped_column(String(64), nullable=False)
    data: Mapped[dict[str, Any]] = mapped_column(nullable=False)

    user: Mapped["User"] = relationship(back_populates="label_presets")

    __table_args__ = (
        CheckConstraint(
            "preset_type IN ('spool', 'filament', 'sheet')",
            name="ck_label_presets_type",
        ),
        CheckConstraint("name <> ''", name="ck_label_presets_name_not_empty"),
        CheckConstraint(
            "length(name_key) = 64",
            name="ck_label_presets_name_key_length",
        ),
        UniqueConstraint(
            "user_id",
            "preset_type",
            "name_key",
            name="uq_label_presets_user_type_name_key",
        ),
        Index("ix_label_presets_user_type", "user_id", "preset_type"),
    )
