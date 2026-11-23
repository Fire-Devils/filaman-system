from sqlalchemy import Boolean, Integer, String, UniqueConstraint, text
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin


class DeviceFirmware(Base, TimestampMixin):
    __tablename__ = "device_firmware"
    __table_args__ = (UniqueConstraint("project", "version", name="uq_device_firmware_project_version"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    project: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    version: Mapped[str] = mapped_column(String(32), nullable=False)
    size: Mapped[int] = mapped_column(Integer, nullable=False)
    sha256: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    is_current: Mapped[bool] = mapped_column(Boolean, default=False, server_default=text("false"), nullable=False)
