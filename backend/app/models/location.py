from typing import Any

from sqlalchemy import String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TimestampMixin

# Printer driver plugins (Bambuddy, Moonraker, …) create one location per AMS
# slot / toolhead and mark it by writing `managed_by` into custom_fields, e.g.
# {"managed_by": "bambuddy_plugin"}. FilaMan core never writes that marker — it
# is a contract external plugins honour, and this is the single place that
# reads it. The frontend mirror lives in src/lib/driver-managed-locations.ts.
MANAGED_BY_FIELD = "managed_by"
DRIVER_MANAGED_SUFFIX = "_plugin"


class Location(Base, TimestampMixin):
    __tablename__ = "locations"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    identifier: Mapped[str | None] = mapped_column(String(100), nullable=True)
    custom_fields: Mapped[dict[str, Any] | None] = mapped_column(nullable=True)

    spools: Mapped[list["Spool"]] = relationship(back_populates="location")
    printers: Mapped[list["Printer"]] = relationship(back_populates="location")
    events_from: Mapped[list["SpoolEvent"]] = relationship(
        back_populates="from_location", foreign_keys="[SpoolEvent.from_location_id]"
    )
    events_to: Mapped[list["SpoolEvent"]] = relationship(
        back_populates="to_location", foreign_keys="[SpoolEvent.to_location_id]"
    )

    @property
    def is_driver_managed(self) -> bool:
        """True for AMS/slot locations owned by a printer driver plugin.

        Such a location may only be claimed when the driver assigns a spool
        after it was physically placed. Spool creation therefore rejects it,
        while updates stay open on purpose — that is the path drivers use to
        assign and release slots.
        """
        custom_fields = self.custom_fields
        if not isinstance(custom_fields, dict):
            return False
        managed = custom_fields.get(MANAGED_BY_FIELD)
        return isinstance(managed, str) and managed.endswith(DRIVER_MANAGED_SUFFIX)


from app.models.spool import Spool, SpoolEvent
from app.models.printer import Printer
