from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import (
    CheckConstraint,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    Integer,
    LargeBinary,
    String,
    UniqueConstraint,
)
from sqlalchemy.dialects.mysql import LONGBLOB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TimestampMixin, TZDateTime

if TYPE_CHECKING:
    from app.models.user import User


class LabelAsset(Base, TimestampMixin):
    __tablename__ = "label_assets"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    user_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    display_name: Mapped[str] = mapped_column(String(120), nullable=False)
    sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    media_type: Mapped[str] = mapped_column(String(32), nullable=False)
    width: Mapped[int] = mapped_column(Integer, nullable=False)
    height: Mapped[int] = mapped_column(Integer, nullable=False)
    byte_size: Mapped[int] = mapped_column(Integer, nullable=False)
    content: Mapped[bytes] = mapped_column(
        LargeBinary().with_variant(LONGBLOB(), "mysql"), nullable=False, deferred=True
    )
    orphaned_at: Mapped[datetime | None] = mapped_column(
        TZDateTime(), nullable=True
    )

    user: Mapped["User"] = relationship(back_populates="label_assets")
    references: Mapped[list["LabelPresetAsset"]] = relationship(
        primaryjoin="LabelAsset.id == foreign(LabelPresetAsset.asset_id)",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )

    __table_args__ = (
        UniqueConstraint("id", "user_id", name="uq_label_assets_id_user"),
        UniqueConstraint(
            "user_id", "sha256", name="uq_label_assets_user_sha256"
        ),
        CheckConstraint("length(sha256) = 64", name="ck_label_assets_sha256"),
        CheckConstraint("width > 0", name="ck_label_assets_width"),
        CheckConstraint("height > 0", name="ck_label_assets_height"),
        CheckConstraint("byte_size > 0", name="ck_label_assets_byte_size"),
        Index("ix_label_assets_user_orphaned", "user_id", "orphaned_at"),
    )


class LabelPresetAsset(Base):
    __tablename__ = "label_preset_assets"

    preset_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    asset_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    user_id: Mapped[int] = mapped_column(Integer, nullable=False)

    __table_args__ = (
        ForeignKeyConstraint(
            ["preset_id", "user_id"],
            ["label_presets.id", "label_presets.user_id"],
            ondelete="CASCADE",
            name="fk_label_preset_assets_preset_user",
        ),
        ForeignKeyConstraint(
            ["asset_id", "user_id"],
            ["label_assets.id", "label_assets.user_id"],
            ondelete="CASCADE",
            name="fk_label_preset_assets_asset_user",
        ),
        Index("ix_label_preset_assets_asset", "asset_id"),
        Index("ix_label_preset_assets_user", "user_id"),
    )
