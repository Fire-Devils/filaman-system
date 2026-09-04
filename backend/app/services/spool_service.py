from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import select, update, func, or_
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.rfid import normalize_rfid_uid, rfid_match_values, rfid_uids_equal
from app.core.security import Principal
from app.models import AppSettings, Filament, Location, Spool, SpoolEvent, SpoolStatus

# Aggregation window for consumption events (in minutes)
# Events within this window from the same source will be aggregated
CONSUMPTION_AGGREGATION_WINDOW_MINUTES = 5

# Sentinel for "argument not supplied" in set_rfid_uids (None means "clear").
_UNSET: Any = object()


class RfidSlotsFullError(Exception):
    """Both RFID slots of the spool are taken and replacing was not allowed."""


@dataclass
class RfidChange:
    """Outcome of an RFID add: who lost the chip, and what this spool dropped."""

    removed_from: list[str] = field(default_factory=list)
    replaced_uid: str | None = None
    replaced_slot: int | None = None
    already_assigned: bool = False


class SpoolService:
    def __init__(self, db: AsyncSession):
        self.db = db

    async def get_spool(self, spool_id: int) -> Spool | None:
        result = await self.db.execute(
            select(Spool)
            .where(Spool.id == spool_id)
            .options(
                selectinload(Spool.filament).selectinload(Filament.manufacturer),
                selectinload(Spool.status),
            )
        )
        return result.scalar_one_or_none()

    # ------------------------------------------------------------------
    # RFID: two chips per spool (rfid_uid + rfid_uid_2)
    # ------------------------------------------------------------------

    @staticmethod
    def _rfid_filter(uid: str):
        """SQL condition: either RFID slot of a spool holds ``uid`` (any spelling)."""
        values = rfid_match_values(uid)
        return or_(
            func.upper(Spool.rfid_uid).in_(values),
            func.upper(Spool.rfid_uid_2).in_(values),
        )

    @staticmethod
    def _normalize_slots(spool: Spool) -> None:
        """Keep the invariant: rfid_uid is filled before rfid_uid_2, no duplicates."""
        if spool.rfid_uid and spool.rfid_uid_2 and rfid_uids_equal(
            spool.rfid_uid, spool.rfid_uid_2
        ):
            spool.rfid_uid_2 = None
        if spool.rfid_uid is None and spool.rfid_uid_2 is not None:
            spool.rfid_uid, spool.rfid_uid_2 = spool.rfid_uid_2, None

    @staticmethod
    def spool_has_rfid(spool: Spool, uid: str | None) -> bool:
        return rfid_uids_equal(spool.rfid_uid, uid) or rfid_uids_equal(
            spool.rfid_uid_2, uid
        )

    async def find_spool_by_rfid(
        self, uid: str | None, *, exclude_spool_id: int | None = None
    ) -> Spool | None:
        """Find the spool owning ``uid`` in either slot (no relationships loaded)."""
        if not uid or not uid.strip():
            return None
        query = select(Spool).where(self._rfid_filter(uid))
        if exclude_spool_id is not None:
            query = query.where(Spool.id != exclude_spool_id)
        result = await self.db.execute(query.limit(1))
        return result.scalar_one_or_none()

    async def release_rfid_uid(
        self,
        uid: str,
        *,
        exclude_spool_id: int | None = None,
        exclude_location_id: int | None = None,
    ) -> list[str]:
        """Take ``uid`` away from every other spool slot and location identifier.

        Flushes before returning so a subsequent assignment of the same UID
        cannot trip the unique indexes.  Returns human-readable owners that
        lost the chip (same wording the write-tag flow has always reported).
        """
        removed: list[str] = []
        values = rfid_match_values(uid)

        spool_query = select(Spool).where(self._rfid_filter(uid))
        if exclude_spool_id is not None:
            spool_query = spool_query.where(Spool.id != exclude_spool_id)
        for other in (await self.db.execute(spool_query)).scalars().all():
            if other.rfid_uid and other.rfid_uid.upper() in values:
                other.rfid_uid = None
            if other.rfid_uid_2 and other.rfid_uid_2.upper() in values:
                other.rfid_uid_2 = None
            self._normalize_slots(other)
            removed.append(f"Spule #{other.id}")

        loc_query = select(Location).where(func.upper(Location.identifier).in_(values))
        if exclude_location_id is not None:
            loc_query = loc_query.where(Location.id != exclude_location_id)
        for loc in (await self.db.execute(loc_query)).scalars().all():
            loc.identifier = None
            removed.append(f"Standort '{loc.name}'")

        if removed:
            await self.db.flush()
        return removed

    async def set_rfid_uids(
        self,
        spool: Spool,
        *,
        rfid_uid: str | None = _UNSET,
        rfid_uid_2: str | None = _UNSET,
    ) -> list[str]:
        """Set one or both RFID slots to the given values (None clears a slot).

        Values are normalised, duplicates collapsed, and the primary slot is
        back-filled from the secondary so ``rfid_uid`` is never empty while a
        chip exists.  Any UID new to this spool is stolen from other owners.
        Returns the list of previous owners.  Flushes, does not commit.
        """
        primary = (
            spool.rfid_uid if rfid_uid is _UNSET else normalize_rfid_uid(rfid_uid)
        )
        secondary = (
            spool.rfid_uid_2
            if rfid_uid_2 is _UNSET
            else normalize_rfid_uid(rfid_uid_2)
        )
        if primary and secondary and rfid_uids_equal(primary, secondary):
            secondary = None
        if primary is None and secondary is not None:
            primary, secondary = secondary, None

        removed: list[str] = []
        for new_uid in (primary, secondary):
            if new_uid and not self.spool_has_rfid(spool, new_uid):
                removed.extend(
                    await self.release_rfid_uid(new_uid, exclude_spool_id=spool.id)
                )

        spool.rfid_uid = primary
        spool.rfid_uid_2 = secondary
        await self.db.flush()
        return removed

    async def add_rfid_uid(
        self,
        spool: Spool,
        uid: str,
        *,
        replace_secondary: bool = False,
        replace_slot: int | None = None,
    ) -> RfidChange:
        """Attach ``uid`` to the first free slot of ``spool``.

        No-op when the chip is already on this spool.  ``replace_slot`` (1 or
        2) forces the chip into that slot, replacing whatever is there — the
        UI offers this when both slots are full (e.g. tag 1 fell off).
        Otherwise, when both slots are taken the secondary is replaced if
        ``replace_secondary`` is set (write-tag flow: the chip is already
        physically written, so refusing would desync DB and chip), else
        :class:`RfidSlotsFullError`.
        """
        canonical = normalize_rfid_uid(uid)
        if canonical is None:
            raise ValueError("RFID UID must not be empty")
        if self.spool_has_rfid(spool, canonical):
            return RfidChange(already_assigned=True)
        if replace_slot in (1, 2):
            if replace_slot == 1:
                replaced = spool.rfid_uid
                removed = await self.set_rfid_uids(spool, rfid_uid=canonical)
            else:
                replaced = spool.rfid_uid_2
                removed = await self.set_rfid_uids(spool, rfid_uid_2=canonical)
            return RfidChange(
                removed_from=removed,
                replaced_uid=replaced,
                replaced_slot=replace_slot if replaced else None,
            )
        if spool.rfid_uid is None:
            return RfidChange(removed_from=await self.set_rfid_uids(spool, rfid_uid=canonical))
        if spool.rfid_uid_2 is None:
            return RfidChange(removed_from=await self.set_rfid_uids(spool, rfid_uid_2=canonical))
        if not replace_secondary:
            raise RfidSlotsFullError(
                f"Spool #{spool.id} already has two RFID tags; remove one first"
            )
        replaced = spool.rfid_uid_2
        removed = await self.set_rfid_uids(spool, rfid_uid_2=canonical)
        return RfidChange(removed_from=removed, replaced_uid=replaced, replaced_slot=2)

    async def remove_rfid_uid(self, spool: Spool, uid: str) -> bool:
        """Detach ``uid`` from whichever slot holds it. Returns False if absent."""
        if rfid_uids_equal(spool.rfid_uid, uid):
            await self.set_rfid_uids(spool, rfid_uid=None)
            return True
        if rfid_uids_equal(spool.rfid_uid_2, uid):
            await self.set_rfid_uids(spool, rfid_uid_2=None)
            return True
        return False

    async def get_spool_by_identifier(
        self, rfid_uid: str | None, external_id: str | None
    ) -> Spool | None:
        if rfid_uid and rfid_uid.strip():
            result = await self.db.execute(
                select(Spool)
                .where(self._rfid_filter(rfid_uid))
                .options(
                    selectinload(Spool.filament).selectinload(Filament.manufacturer),
                    selectinload(Spool.status),
                )
                .limit(1)
            )
            spool = result.scalar_one_or_none()
            if spool:
                return spool
        if external_id:
            result = await self.db.execute(
                select(Spool)
                .where(Spool.external_id == external_id)
                .options(
                    selectinload(Spool.filament).selectinload(Filament.manufacturer),
                    selectinload(Spool.status),
                )
            )
            return result.scalar_one_or_none()
        return None

    def _get_tara(self, spool: Spool, core_weight_g: float = 0.0) -> float | None:
        base = None
        if spool.empty_spool_weight_g is not None:
            base = spool.empty_spool_weight_g
        elif spool.filament and spool.filament.default_spool_weight_g is not None:
            base = spool.filament.default_spool_weight_g
        if base is None:
            return None
        return base + core_weight_g

    async def _resolve_core_weight(self, spool: Spool) -> float:
        """Return the effective core weight for a spool.

        Priority:
        1. Per-spool spool_core_weight_g (including explicit 0 to disable default)
        2. Global default_spool_core_weight_g from AppSettings
        3. 0 (no adjustment)
        """
        if spool.spool_core_weight_g is not None:
            return spool.spool_core_weight_g
        settings_result = await self.db.execute(
            select(AppSettings).where(AppSettings.id == 1)
        )
        app_settings = settings_result.scalar_one_or_none()
        if app_settings and app_settings.default_spool_core_weight_g is not None:
            return app_settings.default_spool_core_weight_g
        return 0.0

    async def _get_status_by_key(self, key: str) -> SpoolStatus | None:
        result = await self.db.execute(
            select(SpoolStatus).where(SpoolStatus.key == key)
        )
        return result.scalar_one_or_none()

    async def _get_aggregatable_consumption_event(
        self,
        spool_id: int,
        source: str,
        current_time: datetime,
    ) -> SpoolEvent | None:
        """
        Find a recent consumption event that can be aggregated with a new one.

        Returns the most recent print_consumption event for this spool if:
        - It's from the same source
        - It's within the aggregation window (5 minutes)

        Otherwise returns None (a new event should be created).
        """
        window_start = current_time - timedelta(
            minutes=CONSUMPTION_AGGREGATION_WINDOW_MINUTES
        )

        result = await self.db.execute(
            select(SpoolEvent)
            .where(
                SpoolEvent.spool_id == spool_id,
                SpoolEvent.event_type == "print_consumption",
                SpoolEvent.source == source,
                SpoolEvent.event_at >= window_start,
            )
            .order_by(SpoolEvent.event_at.desc())
            .limit(1)
        )
        return result.scalar_one_or_none()

    async def _create_event(
        self,
        spool_id: int,
        event_type: str,
        event_at: datetime,
        user_id: int | None = None,
        device_id: int | None = None,
        source: str | None = None,
        delta_weight_g: float | None = None,
        measured_weight_g: float | None = None,
        from_status_id: int | None = None,
        to_status_id: int | None = None,
        from_location_id: int | None = None,
        to_location_id: int | None = None,
        note: str | None = None,
        meta: dict[str, Any] | None = None,
    ) -> SpoolEvent:
        event = SpoolEvent(
            spool_id=spool_id,
            event_type=event_type,
            event_at=event_at,
            user_id=user_id,
            device_id=device_id,
            source=source,
            delta_weight_g=delta_weight_g,
            measured_weight_g=measured_weight_g,
            from_status_id=from_status_id,
            to_status_id=to_status_id,
            from_location_id=from_location_id,
            to_location_id=to_location_id,
            note=note,
            meta=meta,
        )
        self.db.add(event)
        await self.db.flush()
        return event

    async def _handle_auto_empty(
        self,
        spool: Spool,
        remaining: float,
        trigger_event_id: int,
        event_at: datetime,
    ) -> None:
        if remaining == 0 and spool.status.key != "empty":
            empty_status = await self._get_status_by_key("empty")
            if empty_status:
                spool.status_id = empty_status.id
                await self._create_event(
                    spool_id=spool.id,
                    event_type="empty",
                    event_at=event_at,
                    source="system",
                    from_status_id=spool.status_id,
                    to_status_id=empty_status.id,
                    meta={
                        "auto": True,
                        "trigger_event_id": trigger_event_id,
                    },
                )

    async def _handle_auto_opened(
        self,
        spool: Spool,
        event_at: datetime,
    ) -> None:
        """Auto-transition from 'new' to 'opened' when weight changes."""
        if spool.status and spool.status.key == "new":
            opened_status = await self._get_status_by_key("opened")
            if opened_status:
                old_status_id = spool.status_id
                spool.status_id = opened_status.id
                await self._create_event(
                    spool_id=spool.id,
                    event_type="opened",
                    event_at=event_at,
                    source="system",
                    from_status_id=old_status_id,
                    to_status_id=opened_status.id,
                    meta={
                        "auto": True,
                        "reason": "weight_changed",
                    },
                )

    async def record_measurement(
        self,
        spool: Spool,
        measured_weight_g: float,
        event_at: datetime,
        principal: Principal | None = None,
        source: str = "ui",
        note: str | None = None,
    ) -> tuple[SpoolEvent, float | None]:
        core_weight_g = await self._resolve_core_weight(spool)
        tara = self._get_tara(spool, core_weight_g)
        meta: dict[str, Any] = {}

        if tara is None:
            meta["tara_missing"] = True
            event = await self._create_event(
                spool_id=spool.id,
                event_type="measurement",
                event_at=event_at,
                user_id=principal.user_id if principal else None,
                device_id=principal.device_id if principal else None,
                source=source,
                measured_weight_g=measured_weight_g,
                note=note,
                meta=meta,
            )
            return event, spool.remaining_weight_g

        remaining = measured_weight_g - tara
        clamped = False

        if remaining < 0:
            remaining = 0
            meta["clamped_to_zero"] = True
            clamped = True

        event = await self._create_event(
            spool_id=spool.id,
            event_type="measurement",
            event_at=event_at,
            user_id=principal.user_id if principal else None,
            device_id=principal.device_id if principal else None,
            source=source,
            measured_weight_g=measured_weight_g,
            note=note,
            meta=meta if meta else None,
        )

        spool.remaining_weight_g = remaining

        await self._handle_auto_opened(spool, event_at)

        if remaining == 0 and not clamped:
            await self._handle_auto_empty(spool, remaining, event.id, event_at)

        await self.db.commit()
        return event, remaining

    async def record_adjustment(
        self,
        spool: Spool,
        adjustment_type: str,
        event_at: datetime,
        delta_weight_g: float | None = None,
        measured_weight_g: float | None = None,
        principal: Principal | None = None,
        source: str = "ui",
        note: str | None = None,
    ) -> tuple[SpoolEvent, float | None]:
        meta: dict[str, Any] = {"adjustment_type": adjustment_type}

        if adjustment_type == "relative":
            if delta_weight_g is None:
                raise ValueError("delta_weight_g required for relative adjustment")

            if spool.remaining_weight_g is None:
                event = await self._create_event(
                    spool_id=spool.id,
                    event_type="manual_adjust",
                    event_at=event_at,
                    user_id=principal.user_id if principal else None,
                    device_id=principal.device_id if principal else None,
                    source=source,
                    delta_weight_g=delta_weight_g,
                    note=note,
                    meta=meta,
                )
                await self.db.commit()
                return event, None

            remaining = spool.remaining_weight_g + delta_weight_g

        elif adjustment_type == "absolute":
            if measured_weight_g is None:
                raise ValueError("measured_weight_g required for absolute adjustment")

            core_weight_g = await self._resolve_core_weight(spool)
            tara = self._get_tara(spool, core_weight_g)

            if tara is None:
                meta["tara_missing"] = True
                event = await self._create_event(
                    spool_id=spool.id,
                    event_type="manual_adjust",
                    event_at=event_at,
                    user_id=principal.user_id if principal else None,
                    device_id=principal.device_id if principal else None,
                    source=source,
                    measured_weight_g=measured_weight_g,
                    note=note,
                    meta=meta,
                )
                await self.db.commit()
                return event, spool.remaining_weight_g

            remaining = measured_weight_g - tara

        else:
            raise ValueError(f"Invalid adjustment_type: {adjustment_type}")

        clamped = False
        if remaining < 0:
            remaining = 0
            meta["clamped_to_zero"] = True
            clamped = True

        event = await self._create_event(
            spool_id=spool.id,
            event_type="manual_adjust",
            event_at=event_at,
            user_id=principal.user_id if principal else None,
            device_id=principal.device_id if principal else None,
            source=source,
            delta_weight_g=delta_weight_g,
            measured_weight_g=measured_weight_g,
            note=note,
            meta=meta,
        )

        spool.remaining_weight_g = remaining

        await self._handle_auto_opened(spool, event_at)

        if remaining == 0 and not clamped:
            await self._handle_auto_empty(spool, remaining, event.id, event_at)

        await self.db.commit()
        return event, remaining

    async def record_consumption(
        self,
        spool: Spool,
        delta_weight_g: float,
        event_at: datetime,
        principal: Principal | None = None,
        source: str = "ui",
        note: str | None = None,
    ) -> tuple[SpoolEvent, float | None]:
        if delta_weight_g > 0:
            delta_weight_g = -delta_weight_g

        # Check if we can aggregate with a recent event
        existing_event = await self._get_aggregatable_consumption_event(
            spool_id=spool.id,
            source=source,
            current_time=event_at,
        )

        if existing_event is not None:
            # Aggregate: update existing event instead of creating new one
            existing_meta = existing_event.meta or {}
            aggregation_count = existing_meta.get("aggregation_count", 1) + 1

            # Keep track of first event time
            if "first_event_at" not in existing_meta:
                existing_meta["first_event_at"] = existing_event.event_at.isoformat()

            existing_meta["aggregation_count"] = aggregation_count

            # Accumulate delta
            new_delta = (existing_event.delta_weight_g or 0) + delta_weight_g
            existing_event.delta_weight_g = new_delta
            existing_event.event_at = event_at
            existing_event.meta = existing_meta

            # Update spool remaining weight
            if spool.remaining_weight_g is not None:
                remaining = spool.remaining_weight_g + delta_weight_g
                if remaining < 0:
                    remaining = 0
                    existing_meta["clamped_to_zero"] = True
                    existing_event.meta = existing_meta

                spool.remaining_weight_g = remaining
                spool.last_used_at = event_at

                await self._handle_auto_opened(spool, event_at)

                if remaining == 0:
                    await self._handle_auto_empty(
                        spool, remaining, existing_event.id, event_at
                    )

            await self.db.commit()
            return existing_event, spool.remaining_weight_g

        # No aggregation possible - create new event
        meta: dict[str, Any] = {}

        if spool.remaining_weight_g is None:
            event = await self._create_event(
                spool_id=spool.id,
                event_type="print_consumption",
                event_at=event_at,
                user_id=principal.user_id if principal else None,
                device_id=principal.device_id if principal else None,
                source=source,
                delta_weight_g=delta_weight_g,
                note=note,
                meta=meta if meta else None,
            )
            await self.db.commit()
            return event, None

        remaining = spool.remaining_weight_g + delta_weight_g
        clamped = False

        if remaining < 0:
            remaining = 0
            meta["clamped_to_zero"] = True
            clamped = True

        event = await self._create_event(
            spool_id=spool.id,
            event_type="print_consumption",
            event_at=event_at,
            user_id=principal.user_id if principal else None,
            device_id=principal.device_id if principal else None,
            source=source,
            delta_weight_g=delta_weight_g,
            note=note,
            meta=meta if meta else None,
        )

        spool.remaining_weight_g = remaining
        spool.last_used_at = event_at

        await self._handle_auto_opened(spool, event_at)

        if remaining == 0 and not clamped:
            await self._handle_auto_empty(spool, remaining, event.id, event_at)

        await self.db.commit()
        return event, remaining

    async def change_status(
        self,
        spool: Spool,
        status_key: str,
        event_at: datetime,
        principal: Principal | None = None,
        source: str = "ui",
        note: str | None = None,
        meta: dict[str, Any] | None = None,
    ) -> SpoolEvent:
        new_status = await self._get_status_by_key(status_key)
        if new_status is None:
            raise ValueError(f"Status not found: {status_key}")

        old_status_id = spool.status_id

        event = await self._create_event(
            spool_id=spool.id,
            event_type=status_key,
            event_at=event_at,
            user_id=principal.user_id if principal else None,
            device_id=principal.device_id if principal else None,
            source=source,
            from_status_id=old_status_id,
            to_status_id=new_status.id,
            note=note,
            meta=meta,
        )

        spool.status_id = new_status.id
        await self.db.commit()
        return event

    async def change_statuses_bulk(
        self,
        spool_ids: list[int],
        status_key: str,
        principal: Principal | None = None,
        source: str = "ui",
        note: str | None = None,
    ) -> int:
        new_status = await self._get_status_by_key(status_key)
        if new_status is None:
            raise ValueError(f"Status not found: {status_key}")

        event_at = datetime.now(timezone.utc)
        count = 0

        # Bulk-fetch all spools in one query instead of N+1 per-spool selects
        result = await self.db.execute(
            select(Spool)
            .where(Spool.id.in_(spool_ids))
            .options(
                selectinload(Spool.filament).selectinload(Filament.manufacturer),
                selectinload(Spool.status),
            )
        )
        spools = {s.id: s for s in result.scalars().unique().all()}

        for sid in spool_ids:
            spool = spools.get(sid)
            if not spool:
                continue

            old_status_id = spool.status_id
            await self._create_event(
                spool_id=spool.id,
                event_type=status_key,
                event_at=event_at,
                user_id=principal.user_id if principal else None,
                source=source,
                from_status_id=old_status_id,
                to_status_id=new_status.id,
                note=note,
            )
            spool.status_id = new_status.id
            count += 1

        await self.db.commit()
        return count

    async def move_location(
        self,
        spool: Spool,
        to_location_id: int | None,
        event_at: datetime,
        principal: Principal | None = None,
        source: str = "ui",
        note: str | None = None,
    ) -> SpoolEvent:
        from_location_id = spool.location_id

        event = await self._create_event(
            spool_id=spool.id,
            event_type="move_location",
            event_at=event_at,
            user_id=principal.user_id if principal else None,
            device_id=principal.device_id if principal else None,
            source=source,
            from_location_id=from_location_id,
            to_location_id=to_location_id,
            note=note,
        )

        spool.location_id = to_location_id
        await self.db.commit()
        return event

    async def rebuild_remaining_weight(self, spool: Spool) -> float | None:
        result = await self.db.execute(
            select(SpoolEvent)
            .where(SpoolEvent.spool_id == spool.id)
            .order_by(SpoolEvent.event_at.asc())
        )
        events = result.scalars().all()

        # Start with net material weight if weight data is available,
        # so spools with no events get the correct initial remaining value
        remaining: float | None = None
        if (
            spool.initial_total_weight_g is not None
            and spool.empty_spool_weight_g is not None
        ):
            remaining = max(
                spool.initial_total_weight_g - spool.empty_spool_weight_g, 0
            )

        last_plausible_remaining: float | None = spool.remaining_weight_g
        blocked_event_id: int | None = None
        rebuild_core_weight = await self._resolve_core_weight(spool)

        for event in events:
            if event.event_type == "measurement":
                tara = self._get_tara(spool, rebuild_core_weight)
                if tara is None:
                    blocked_event_id = event.id
                    remaining = None
                    await self._create_event(
                        spool_id=spool.id,
                        event_type="manual_adjust",
                        event_at=datetime.now(timezone.utc),
                        source="system",
                        meta={
                            "source": "rebuild",
                            "warning": "tara_missing",
                            "last_plausible_remaining_g": last_plausible_remaining,
                            "affected_event_id": blocked_event_id,
                        },
                        note="Rebuild blocked: tara missing, remaining set to NULL",
                    )
                    spool.remaining_weight_g = None
                    await self.db.commit()
                    return None

                remaining = event.measured_weight_g - tara
                if remaining < 0:
                    remaining = 0

            elif event.event_type == "manual_adjust":
                adj_type = event.meta.get("adjustment_type") if event.meta else None
                if adj_type == "absolute":
                    tara = self._get_tara(spool, rebuild_core_weight)
                    if tara is None:
                        blocked_event_id = event.id
                        remaining = None
                        await self._create_event(
                            spool_id=spool.id,
                            event_type="manual_adjust",
                            event_at=datetime.now(timezone.utc),
                            source="system",
                            meta={
                                "source": "rebuild",
                                "warning": "tara_missing",
                                "last_plausible_remaining_g": last_plausible_remaining,
                                "affected_event_id": blocked_event_id,
                            },
                            note="Rebuild blocked: tara missing, remaining set to NULL",
                        )
                        spool.remaining_weight_g = None
                        await self.db.commit()
                        return None

                    remaining = event.measured_weight_g - tara
                    if remaining < 0:
                        remaining = 0

                elif adj_type == "relative" and remaining is not None:
                    remaining += event.delta_weight_g
                    if remaining < 0:
                        remaining = 0

            elif event.event_type == "print_consumption" and remaining is not None:
                remaining += event.delta_weight_g
                if remaining < 0:
                    remaining = 0

            if remaining is not None:
                last_plausible_remaining = remaining

        spool.remaining_weight_g = remaining

        if remaining == 0 and spool.status.key != "empty":
            empty_status = await self._get_status_by_key("empty")
            if empty_status:
                spool.status_id = empty_status.id
                await self._create_event(
                    spool_id=spool.id,
                    event_type="empty",
                    event_at=datetime.now(timezone.utc),
                    source="system",
                    to_status_id=empty_status.id,
                    meta={
                        "auto": True,
                        "source": "rebuild",
                        "reason": "remaining_rebuilt_to_zero",
                    },
                )

        await self.db.commit()
        return remaining
