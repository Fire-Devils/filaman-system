from datetime import datetime
from typing import Any

from sqlalchemy import select, update, func
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.security import Principal
from app.models import Filament, Location, Spool, SpoolEvent, SpoolStatus


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

    async def get_spool_by_identifier(self, rfid_uid: str | None, external_id: str | None) -> Spool | None:
        if rfid_uid:
            result = await self.db.execute(
                select(Spool)
                .where(func.lower(Spool.rfid_uid) == rfid_uid.lower())
                .options(
                    selectinload(Spool.filament).selectinload(Filament.manufacturer),
                    selectinload(Spool.status),
                )
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

    def _get_tara(self, spool: Spool) -> float | None:
        if spool.empty_spool_weight_g is not None:
            return spool.empty_spool_weight_g
        if spool.filament and spool.filament.default_spool_weight_g is not None:
            return spool.filament.default_spool_weight_g
        return None

    async def _get_status_by_key(self, key: str) -> SpoolStatus | None:
        result = await self.db.execute(select(SpoolStatus).where(SpoolStatus.key == key))
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
        tara = self._get_tara(spool)
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

            tara = self._get_tara(spool)

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

        event_at = datetime.utcnow()
        count = 0
        
        # We process one by one to ensure events are created. 
        # For small numbers (dashboard modals), this is fine.
        for sid in spool_ids:
            spool = await self.get_spool(sid)
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

        remaining: float | None = None
        last_plausible_remaining: float | None = spool.remaining_weight_g
        blocked_event_id: int | None = None

        for event in events:
            if event.event_type == "measurement":
                tara = self._get_tara(spool)
                if tara is None:
                    blocked_event_id = event.id
                    remaining = None
                    await self._create_event(
                        spool_id=spool.id,
                        event_type="manual_adjust",
                        event_at=datetime.utcnow(),
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
                    tara = self._get_tara(spool)
                    if tara is None:
                        blocked_event_id = event.id
                        remaining = None
                        await self._create_event(
                            spool_id=spool.id,
                            event_type="manual_adjust",
                            event_at=datetime.utcnow(),
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
                    event_at=datetime.utcnow(),
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
