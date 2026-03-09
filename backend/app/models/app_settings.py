"""AppSettings model for global application configuration."""

from sqlalchemy import Boolean
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin


class AppSettings(Base, TimestampMixin):
    """Single-row table storing global application settings.

    Only one row (id=1) is expected. The application upserts this row
    whenever a setting is modified.
    """

    __tablename__ = "app_settings"

    id: Mapped[int] = mapped_column(autoincrement=True, primary_key=True)
    login_disabled: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
