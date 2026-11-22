from datetime import datetime
from typing import Any

from sqlalchemy import Boolean, Float, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TimestampMixin, TZDateTime

PRINT_JOB_STATUSES = ("pending", "completed", "failed", "cancelled")
PRINT_JOB_SOURCES = ("manual", "slicer_link", "api")


class PrintProject(Base, TimestampMixin):
    __tablename__ = "print_projects"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    is_archived: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    jobs: Mapped[list["PrintJob"]] = relationship(back_populates="project")


class PrintJob(Base, TimestampMixin):
    __tablename__ = "print_jobs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    project_id: Mapped[int | None] = mapped_column(
        Integer,
        ForeignKey("print_projects.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    printer_id: Mapped[int | None] = mapped_column(
        Integer, ForeignKey("printers.id", ondelete="SET NULL"), nullable=True, index=True
    )
    status: Mapped[str] = mapped_column(
        String(20), nullable=False, default="pending", index=True
    )
    source: Mapped[str] = mapped_column(String(50), nullable=False, default="manual")
    started_at: Mapped[datetime | None] = mapped_column(TZDateTime(), nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(TZDateTime(), nullable=True)
    print_time_s: Mapped[int | None] = mapped_column(Integer, nullable=True)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    photo_file: Mapped[str | None] = mapped_column(String(255), nullable=True)
    meta: Mapped[dict[str, Any] | None] = mapped_column(nullable=True)
    user_id: Mapped[int | None] = mapped_column(
        Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )

    project: Mapped["PrintProject | None"] = relationship(back_populates="jobs")
    usages: Mapped[list["PrintJobUsage"]] = relationship(
        back_populates="job",
        cascade="all, delete-orphan",
        order_by="PrintJobUsage.id",
    )


class PrintJobUsage(Base):
    __tablename__ = "print_job_usages"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    print_job_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("print_jobs.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    spool_id: Mapped[int | None] = mapped_column(
        Integer, ForeignKey("spools.id", ondelete="SET NULL"), nullable=True, index=True
    )
    slot_no: Mapped[int | None] = mapped_column(Integer, nullable=True)
    planned_weight_g: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    used_weight_g: Mapped[float | None] = mapped_column(Float, nullable=True)
    cost: Mapped[float | None] = mapped_column(Float, nullable=True)
    spool_event_id: Mapped[int | None] = mapped_column(
        Integer, ForeignKey("spool_events.id", ondelete="SET NULL"), nullable=True
    )

    job: Mapped["PrintJob"] = relationship(back_populates="usages")
    spool = relationship("Spool")
