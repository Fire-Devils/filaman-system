import logging
import inspect
import contextlib
from typing import Any

import httpx
from fastapi import APIRouter, HTTPException, Query, Request, status
from pydantic import BaseModel
from sqlalchemy import delete as sa_delete, func, select
from sqlalchemy.orm import selectinload

from app.core.security import Principal
from app.api.deps import DBSession, PrincipalDep, RequirePermission, ensure_any_permission
from app.api.v1.schemas import PaginatedResponse
from app.models import (
    Location,
    Printer,
    PrinterSlot,
    PrinterSlotAssignment,
    Spool,
    Filament,
    FilamentColor,
)
from app.core.shared_health import shared_health_store
from app.plugins.manager import plugin_manager

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/printers", tags=["printers"])

_PRIMARY_PROXY_HEADER = "x-filaman-primary-hop"
_PRIMARY_PROXY_MAX_HOPS = 12
_PRIMARY_PROXY_RETRIES = 8


def _is_primary_worker() -> bool:
    """Resolve primary worker state lazily to avoid import cycles."""
    try:
        from app import main as app_main

        return bool(getattr(app_main, "_is_primary", False))
    except Exception:
        return False


def _ensure_primary_worker() -> None:
    if not _is_primary_worker():
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={
                "code": "primary_worker_required",
                "message": "Driver control is available on the primary worker only. Please retry.",
            },
        )


def _is_primary_required_error(detail: Any) -> bool:
    return isinstance(detail, dict) and detail.get("code") == "primary_worker_required"


def _forward_headers(request: Request, hop: int) -> dict[str, str]:
    headers: dict[str, str] = {}
    for key in ("authorization", "cookie", "x-csrf-token", "accept"):
        value = request.headers.get(key)
        if value:
            headers[key] = value
    headers[_PRIMARY_PROXY_HEADER] = str(hop + 1)
    return headers


async def _proxy_to_primary(
    request: Request,
    method: str,
    path: str,
    json_body: dict[str, Any] | None = None,
) -> Any:
    hop_header = request.headers.get(_PRIMARY_PROXY_HEADER, "0")
    hop = int(hop_header) if hop_header.isdigit() else 0
    if hop >= _PRIMARY_PROXY_MAX_HOPS:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={
                "code": "primary_proxy_failed",
                "message": "Could not route request to primary worker",
            },
        )

    target = request.url.replace(path=path, query="")
    # Route through same service endpoint and rely on retry loop to
    # eventually hit the primary worker.
    url = str(target)
    headers = _forward_headers(request, hop)

    async with httpx.AsyncClient(timeout=10.0) as client:
        for _ in range(_PRIMARY_PROXY_RETRIES):
            response = await client.request(
                method,
                url,
                params=request.query_params,
                headers=headers,
                json=json_body,
            )

            payload: Any = None
            with contextlib.suppress(Exception):
                payload = response.json()

            if response.status_code == status.HTTP_503_SERVICE_UNAVAILABLE:
                detail = payload.get("detail") if isinstance(payload, dict) else None
                if _is_primary_required_error(detail):
                    continue

            if response.status_code >= 400:
                if isinstance(payload, dict) and "detail" in payload:
                    raise HTTPException(status_code=response.status_code, detail=payload["detail"])
                raise HTTPException(
                    status_code=response.status_code,
                    detail={
                        "code": "proxy_failed",
                        "message": response.text,
                    },
                )

            return payload

    raise HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail={
            "code": "primary_proxy_failed",
            "message": "Could not route request to primary worker",
        },
    )


class PrinterCreate(BaseModel):
    name: str
    location_id: int | None = None
    driver_key: str
    driver_config: dict | None = None


class PrinterUpdate(BaseModel):
    name: str | None = None
    location_id: int | None = None
    is_active: bool | None = None
    driver_key: str | None = None
    driver_config: dict | None = None


class SlotAssignmentResponse(BaseModel):
    present: bool = False
    spool_id: int | None = None
    spool_name: str | None = None
    filament_name: str | None = None
    manufacturer_name: str | None = None
    material_type: str | None = None
    color_hex: str | None = None
    color_name: str | None = None
    tray_color: str | None = None
    tray_type: str | None = None
    tray_info_idx: str | None = None
    nozzle_temp_min: int | None = None
    nozzle_temp_max: int | None = None
    setting_id: str | None = None
    cali_idx: int | None = None
    meta: dict | None = None

    class Config:
        from_attributes = True


class SlotResponse(BaseModel):
    id: int
    printer_id: int
    slot_no: int
    name: str | None
    is_active: bool
    custom_fields: dict | None = None
    assignment: SlotAssignmentResponse | None = None

    class Config:
        from_attributes = True


class PrinterResponse(BaseModel):
    id: int
    name: str
    location_id: int | None
    is_active: bool
    driver_key: str
    custom_fields: dict | None = None

    class Config:
        from_attributes = True


class PrinterDetailResponse(PrinterResponse):
    driver_config: dict | None = None
    slots: list[SlotResponse] = []


@router.get("", response_model=PaginatedResponse[PrinterResponse])
async def list_printers(
    db: DBSession,
    principal: PrincipalDep,
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
):
    query = select(Printer).where(Printer.deleted_at.is_(None)).order_by(Printer.name)
    query = query.offset((page - 1) * page_size).limit(page_size)

    result = await db.execute(query)
    items = result.scalars().all()

    count_query = (
        select(func.count()).select_from(Printer).where(Printer.deleted_at.is_(None))
    )
    count_result = await db.execute(count_query)
    total = count_result.scalar() or 0

    return PaginatedResponse(items=items, page=page, page_size=page_size, total=total)


@router.post("", response_model=PrinterResponse, status_code=status.HTTP_201_CREATED)
async def create_printer(
    data: PrinterCreate,
    db: DBSession,
    principal=RequirePermission("printers:create"),
):
    if data.location_id:
        result = await db.execute(
            select(Location).where(Location.id == data.location_id)
        )
        if not result.scalar_one_or_none():
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail={"code": "validation_error", "message": "Location not found"},
            )

    printer = Printer(**data.model_dump())
    db.add(printer)
    await db.commit()
    await db.refresh(printer)

    # Auto-start driver if printer is active (default)
    if printer.is_active and printer.driver_key:
        started = await plugin_manager.start_printer(printer)
        if not started:
            logger.warning(
                f"Driver {printer.driver_key} could not be started for new printer {printer.id}"
            )

    return printer


@router.get("/{printer_id}", response_model=PrinterDetailResponse)
async def get_printer(
    printer_id: int,
    db: DBSession,
    principal: PrincipalDep,
):
    result = await db.execute(
        select(Printer)
        .where(Printer.id == printer_id, Printer.deleted_at.is_(None))
        .options(
            selectinload(Printer.slots)
            .selectinload(PrinterSlot.assignment)
            .selectinload(PrinterSlotAssignment.spool)
            .selectinload(Spool.filament)
            .options(
                selectinload(Filament.manufacturer),
                selectinload(Filament.filament_colors).selectinload(
                    FilamentColor.color
                ),
            )
        )
    )
    printer = result.scalar_one_or_none()

    if not printer:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "not_found", "message": "Printer not found"},
        )

    # Build slot responses with flattened assignment info
    slot_responses = []
    for slot in sorted(printer.slots, key=lambda s: s.slot_no):
        assignment_data = None
        if slot.assignment:
            a = slot.assignment
            spool = a.spool
            spool_name = None
            filament_name = None
            manufacturer_name = None
            material_type = None
            color_hex = None
            color_name = None
            if spool:
                filament = spool.filament
                spool_name = f"#{spool.id}"
                if filament:
                    filament_name = filament.designation
                    material_type = filament.material_type
                    if filament.manufacturer:
                        manufacturer_name = filament.manufacturer.name
                        spool_name = (
                            f"{filament.manufacturer.name} {filament.designation}"
                        )
                    else:
                        spool_name = filament.designation
                    if filament.filament_colors:
                        first_color = filament.filament_colors[0].color
                        color_hex = first_color.hex_code
                        color_name = first_color.name
            meta = a.meta or {}
            tray_color = meta.get("tray_color")
            tray_type = meta.get("tray_type")
            tray_info_idx = meta.get("tray_info_idx")
            nozzle_temp_min = meta.get("nozzle_temp_min")
            nozzle_temp_max = meta.get("nozzle_temp_max")
            setting_id = meta.get("setting_id")
            cali_idx = meta.get("cali_idx")
            assignment_data = SlotAssignmentResponse(
                present=a.present,
                spool_id=a.spool_id,
                spool_name=spool_name,
                filament_name=filament_name,
                manufacturer_name=manufacturer_name,
                material_type=material_type,
                color_hex=color_hex,
                color_name=color_name,
                tray_color=tray_color,
                tray_type=tray_type,
                tray_info_idx=tray_info_idx,
                nozzle_temp_min=nozzle_temp_min,
                nozzle_temp_max=nozzle_temp_max,
                setting_id=setting_id,
                cali_idx=cali_idx,
                meta=meta,
            )
        slot_responses.append(
            SlotResponse(
                id=slot.id,
                printer_id=slot.printer_id,
                slot_no=slot.slot_no,
                name=slot.name,
                is_active=slot.is_active,
                custom_fields=slot.custom_fields,
                assignment=assignment_data,
            )
        )

    return PrinterDetailResponse(
        id=printer.id,
        name=printer.name,
        location_id=printer.location_id,
        is_active=printer.is_active,
        driver_key=printer.driver_key,
        custom_fields=printer.custom_fields,
        driver_config=printer.driver_config,
        slots=slot_responses,
    )


@router.patch("/{printer_id}", response_model=PrinterResponse)
async def update_printer(
    printer_id: int,
    data: PrinterUpdate,
    db: DBSession,
    principal=RequirePermission("printers:update"),
):
    result = await db.execute(
        select(Printer).where(Printer.id == printer_id, Printer.deleted_at.is_(None))
    )
    printer = result.scalar_one_or_none()

    if not printer:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "not_found", "message": "Printer not found"},
        )

    updates = data.model_dump(exclude_unset=True)
    driver_changed = "driver_key" in updates or "driver_config" in updates
    active_changed = (
        "is_active" in updates and updates["is_active"] != printer.is_active
    )

    for key, value in updates.items():
        setattr(printer, key, value)

    await db.commit()
    await db.refresh(printer)

    # Handle driver lifecycle on relevant changes
    if active_changed and not printer.is_active:
        # Deactivated → stop driver
        await plugin_manager.stop_printer(printer_id)
    elif active_changed and printer.is_active:
        # Activated → start driver
        await plugin_manager.start_printer(printer)
    elif driver_changed and printer.is_active:
        # Config/key changed while active → restart
        await plugin_manager.stop_printer(printer_id)
        await plugin_manager.start_printer(printer)

    return printer


@router.delete("/{printer_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_printer(
    printer_id: int,
    db: DBSession,
    principal=RequirePermission("printers:delete"),
    delete_params: bool = Query(
        False, description="Also hard-delete printer_params for this printer"
    ),
):
    from datetime import datetime, timezone

    from app.models.printer_params import FilamentPrinterParam, SpoolPrinterParam

    result = await db.execute(
        select(Printer).where(Printer.id == printer_id, Printer.deleted_at.is_(None))
    )
    printer = result.scalar_one_or_none()

    if not printer:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "not_found", "message": "Printer not found"},
        )

    # Stop driver before soft-delete
    await plugin_manager.stop_printer(printer_id)

    # Optionally hard-delete calibration data
    if delete_params:
        await db.execute(
            sa_delete(FilamentPrinterParam).where(
                FilamentPrinterParam.printer_id == printer_id
            )
        )
        await db.execute(
            sa_delete(SpoolPrinterParam).where(
                SpoolPrinterParam.printer_id == printer_id
            )
        )
        logger.info(f"Deleted printer_params for printer {printer_id}")

    printer.deleted_at = datetime.now(timezone.utc)
    await db.commit()


@router.get("/{printer_id}/slots", response_model=list[SlotResponse])
async def list_slots(
    printer_id: int,
    db: DBSession,
    principal: PrincipalDep,
):
    result = await db.execute(
        select(PrinterSlot)
        .where(PrinterSlot.printer_id == printer_id)
        .options(
            selectinload(PrinterSlot.assignment)
            .selectinload(PrinterSlotAssignment.spool)
            .selectinload(Spool.filament)
            .selectinload(Filament.manufacturer),
            selectinload(PrinterSlot.assignment)
            .selectinload(PrinterSlotAssignment.spool)
            .selectinload(Spool.filament)
            .selectinload(Filament.filament_colors)
            .selectinload(FilamentColor.color),
        )
        .order_by(PrinterSlot.slot_no)
    )

    slots = result.scalars().all()
    slot_responses: list[SlotResponse] = []

    for slot in slots:
        assignment_data = None
        if slot.assignment:
            a = slot.assignment
            spool = a.spool
            spool_name = None
            filament_name = None
            manufacturer_name = None
            material_type = None
            color_hex = None
            color_name = None
            if spool:
                filament = spool.filament
                spool_name = f"#{spool.id}"
                if filament:
                    filament_name = filament.designation
                    material_type = filament.material_type
                    if filament.manufacturer:
                        manufacturer_name = filament.manufacturer.name
                        spool_name = (
                            f"{filament.manufacturer.name} {filament.designation}"
                        )
                    else:
                        spool_name = filament.designation
                    if filament.filament_colors:
                        first_color = filament.filament_colors[0].color
                        if first_color:
                            color_hex = first_color.hex_code
                            color_name = first_color.name

            meta = a.meta or {}
            assignment_data = SlotAssignmentResponse(
                present=a.present,
                spool_id=a.spool_id,
                spool_name=spool_name,
                filament_name=filament_name,
                manufacturer_name=manufacturer_name,
                material_type=material_type,
                color_hex=color_hex,
                color_name=color_name,
                tray_color=meta.get("tray_color"),
                tray_type=meta.get("tray_type"),
                tray_info_idx=meta.get("tray_info_idx"),
                nozzle_temp_min=meta.get("nozzle_temp_min"),
                nozzle_temp_max=meta.get("nozzle_temp_max"),
                setting_id=meta.get("setting_id"),
                cali_idx=meta.get("cali_idx"),
                meta=meta,
            )

        slot_responses.append(
            SlotResponse(
                id=slot.id,
                printer_id=slot.printer_id,
                slot_no=slot.slot_no,
                name=slot.name,
                is_active=slot.is_active,
                custom_fields=slot.custom_fields,
                assignment=assignment_data,
            )
        )

    return slot_responses


class DriverActionRequest(BaseModel):
    action: str
    params: dict = {}


class DriverActionResponse(BaseModel):
    success: bool
    message: str | None = None
    data: dict | None = None


_READ_ONLY_DRIVER_ACTIONS = frozenset(
    {"list_connected_models", "get_profile_coverage"}
)
_SPOOL_PROFILE_DRIVER_ACTIONS = frozenset(
    {"set_spool_profile_for_model", "set_default_spool_profile"}
)
_FILAMENT_PROFILE_DRIVER_ACTIONS = frozenset(
    {"set_filament_profile_for_model", "set_default_filament_profile"}
)


async def _ensure_driver_action_permission(
    db: DBSession, principal: Principal, action: str
) -> None:
    if action in _READ_ONLY_DRIVER_ACTIONS:
        await ensure_any_permission(
            db, principal, "printers:read", "printers:update"
        )
    elif action in _SPOOL_PROFILE_DRIVER_ACTIONS:
        await ensure_slicer_profile_write_permission(db, principal, entity="spool")
    elif action in _FILAMENT_PROFILE_DRIVER_ACTIONS:
        await ensure_slicer_profile_write_permission(db, principal, entity="filament")
    else:
        await ensure_any_permission(db, principal, "printers:update")


async def ensure_slicer_profile_write_permission(
    db: DBSession, principal: Principal, *, entity: str = "spool"
) -> None:
    """Profile picker is visible to read-only users; allow matching write access."""
    if entity == "filament":
        await ensure_any_permission(
            db,
            principal,
            "filaments:update",
            "printers:update",
            "filaments:read",
        )
    else:
        await ensure_any_permission(
            db,
            principal,
            "spools:update",
            "printers:update",
            "spools:read",
        )


async def pick_bambuddy_driver(db: DBSession) -> tuple[int, Any]:
    """Return (printer_id, driver) for the first running Bambuddy driver."""
    result = await db.execute(
        select(Printer).where(
            Printer.driver_key == "bambuddy",
            Printer.deleted_at.is_(None),
        )
    )
    for printer in result.scalars().all():
        driver = plugin_manager.drivers.get(printer.id)
        if driver is not None:
            return printer.id, driver
    raise HTTPException(
        status_code=status.HTTP_400_BAD_REQUEST,
        detail={
            "code": "driver_not_running",
            "message": "No Bambuddy driver is running",
        },
    )


async def _invoke_driver_method(driver: Any, method_name: str, **kwargs: Any) -> Any:
    method = getattr(driver, method_name, None)
    if not callable(method):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "code": "unsupported",
                "message": f"Driver does not support '{method_name}'",
            },
        )
    result = method(**kwargs)
    if inspect.isawaitable(result):
        result = await result
    return result


@router.post("/{printer_id}/driver/action", response_model=DriverActionResponse)
async def driver_action(
    printer_id: int,
    data: DriverActionRequest,
    request: Request,
    db: DBSession,
    principal: PrincipalDep,
):
    await _ensure_driver_action_permission(db, principal, data.action)
    if not _is_primary_worker():
        payload = await _proxy_to_primary(
            request,
            method="POST",
            path=f"/api/v1/printers/{printer_id}/driver/action",
            json_body=data.model_dump(),
        )
        return DriverActionResponse.model_validate(payload)

    _ensure_primary_worker()

    result = await db.execute(
        select(Printer).where(Printer.id == printer_id, Printer.deleted_at.is_(None))
    )
    printer = result.scalar_one_or_none()

    if not printer:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "not_found", "message": "Printer not found"},
        )

    driver = plugin_manager.drivers.get(printer_id)
    if not driver:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "code": "driver_not_running",
                "message": "Driver is not running for this printer",
            },
        )

    method = getattr(driver, data.action, None)
    if not method or data.action.startswith("_"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "code": "invalid_action",
                "message": f"Action '{data.action}' not available",
            },
        )

    # If the caller supplies a spool_id alongside filament_data, enrich filament_data
    # with printer-specific params (e.g. bambuddy_spool_id) before dispatching to the
    # driver. spool_id is forwarded only when the target method supports it.
    params = dict(data.params)
    spool_id = params.pop("spool_id", None)
    normalized_spool_id: int | None = None
    if spool_id is not None:
        normalized_spool_id = int(spool_id)

    if normalized_spool_id is not None and "filament_data" in params:
        params["filament_data"] = await plugin_manager.enrich_filament_data(
            spool_id=normalized_spool_id,
            printer_id=printer_id,
            filament_data=params["filament_data"],
        )

    if normalized_spool_id is not None:
        method_signature = inspect.signature(method)
        if "spool_id" in method_signature.parameters:
            params["spool_id"] = normalized_spool_id

    try:
        result: Any = None
        if callable(method):
            import asyncio

            if asyncio.iscoroutinefunction(method):
                result = await method(**params)
            else:
                result = method(**params)
        return DriverActionResponse(
            success=True,
            message=f"Action '{data.action}' executed",
            data=result if isinstance(result, dict) else None,
        )
    except TypeError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"code": "invalid_params", "message": str(e)},
        )
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={"code": "action_failed", "message": str(e)},
        )


@router.get("/{printer_id}/driver/connected-models")
async def driver_connected_models(
    printer_id: int,
    request: Request,
    db: DBSession,
    principal: PrincipalDep,
):
    """List distinct Bambu printer models connected via this driver URL."""
    if not _is_primary_worker():
        return await _proxy_to_primary(
            request,
            method="GET",
            path=f"/api/v1/printers/{printer_id}/driver/connected-models",
        )

    driver = plugin_manager.drivers.get(printer_id)
    if not driver:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "code": "driver_not_running",
                "message": "Driver is not running for this printer",
            },
        )

    try:
        return await _invoke_driver_method(driver, "list_connected_models")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={"code": "action_failed", "message": str(e)},
        )


@router.get("/{printer_id}/driver/profile-coverage")
async def driver_profile_coverage(
    printer_id: int,
    request: Request,
    db: DBSession,
    principal: PrincipalDep,
    spool_id: int | None = Query(None),
    filament_id: int | None = Query(None),
):
    """Read-only per-model profile resolution for the slicer profile picker."""
    if not _is_primary_worker():
        qs_parts = []
        if spool_id is not None:
            qs_parts.append(f"spool_id={spool_id}")
        if filament_id is not None:
            qs_parts.append(f"filament_id={filament_id}")
        qs = ("?" + "&".join(qs_parts)) if qs_parts else ""
        return await _proxy_to_primary(
            request,
            method="GET",
            path=f"/api/v1/printers/{printer_id}/driver/profile-coverage{qs}",
        )

    driver = plugin_manager.drivers.get(printer_id)
    if not driver:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "code": "driver_not_running",
                "message": "Driver is not running for this printer",
            },
        )

    try:
        return await _invoke_driver_method(
            driver,
            "get_profile_coverage",
            spool_id=spool_id,
            filament_id=filament_id,
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={"code": "action_failed", "message": str(e)},
        )


@router.get("/{printer_id}/driver/health")
async def driver_health(
    printer_id: int,
    request: Request,
    db: DBSession,
    principal: PrincipalDep,
    refresh: int | None = Query(None),
):
    if refresh and not _is_primary_worker():
        payload = await _proxy_to_primary(
            request,
            method="GET",
            path=f"/api/v1/printers/{printer_id}/driver/health",
        )
        if isinstance(payload, dict):
            return payload

    driver = plugin_manager.drivers.get(printer_id)
    if driver:
        if refresh:
            refresh_status = getattr(driver, "refresh_status", None)
            if callable(refresh_status):
                try:
                    refresh_payload = refresh_status()
                    if inspect.isawaitable(refresh_payload):
                        refresh_payload = await refresh_payload
                    if isinstance(refresh_payload, dict):
                        active_spool_id = refresh_payload.get("active_spool_id")
                        await plugin_manager._handle_slots_update(
                            printer_id,
                            [],
                            None,
                            active_spool_id,
                        )
                except Exception:
                    logger.debug(
                        "driver_health refresh failed for printer %s",
                        printer_id,
                        exc_info=True,
                    )

        health = driver.health()
        # Primary worker: update shared memory so secondaries stay in sync
        shared_health_store.publish({printer_id: health})
        return health

    # No local driver – check shared memory from primary worker
    shared = shared_health_store.read(printer_id)
    if shared is not None:
        return shared

    return {"running": False, "connected": False}


@router.get("/{printer_id}/driver/cloud-presets")
async def driver_cloud_presets(
    printer_id: int,
    request: Request,
    db: DBSession,
    principal: PrincipalDep,
    refresh: int | None = Query(None),
    model: str | None = Query(None),
    group: str | None = Query(None),
):
    """Returns the driver's cloud slicer-profile catalog for the FilaMan picker.

    Read-only. Proxies to the primary worker (where the driver runs).
    Optional ``model`` filters presets; ``group=base`` dedupes by logical base name.
    Response shape: {"presets": [{code, name, displayName, isCustom}], "count": N}.
    """
    if not _is_primary_worker():
        qs_parts = []
        if refresh:
            qs_parts.append("refresh=1")
        if model:
            qs_parts.append(f"model={model}")
        if group:
            qs_parts.append(f"group={group}")
        qs = ("?" + "&".join(qs_parts)) if qs_parts else ""
        payload = await _proxy_to_primary(
            request,
            method="GET",
            path=f"/api/v1/printers/{printer_id}/driver/cloud-presets{qs}",
        )
        if isinstance(payload, dict):
            return payload
        return {"presets": [], "count": 0}

    driver = plugin_manager.drivers.get(printer_id)
    if not driver:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "code": "driver_not_running",
                "message": "Driver is not running for this printer",
            },
        )

    method = getattr(driver, "list_cloud_presets", None)
    if not callable(method):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "code": "unsupported",
                "message": "Driver does not provide a cloud preset catalog",
            },
        )

    try:
        kwargs: dict[str, Any] = {"force": bool(refresh)}
        if model is not None:
            kwargs["model"] = model
        if group is not None:
            kwargs["group"] = group
        result = method(**kwargs)
        if inspect.isawaitable(result):
            result = await result
        if isinstance(result, dict):
            return result
        return {"presets": result or [], "count": len(result or [])}
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={"code": "action_failed", "message": str(e)},
        )


@router.post("/reconnect-all")
async def reconnect_all_printers(
    request: Request,
    db: DBSession,
    principal=RequirePermission("printers:update"),
):
    """Force reconnect for all active printers."""
    if not _is_primary_worker():
        payload = await _proxy_to_primary(
            request,
            method="POST",
            path="/api/v1/printers/reconnect-all",
        )
        return payload

    _ensure_primary_worker()
    results = await plugin_manager.reconnect_all()
    return {"results": {str(k): v for k, v in results.items()}}


@router.get("/{printer_id}/driver/debug")
async def driver_debug_log(
    printer_id: int,
    since: str | None = Query(None),
    db: DBSession = None,
    principal: PrincipalDep = None,
):
    driver = plugin_manager.drivers.get(printer_id)
    if not driver:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "code": "driver_not_running",
                "message": "Driver is not running for this printer",
            },
        )
    return driver.get_debug_log(since_ts=since)


@router.post("/{printer_id}/driver/start", response_model=DriverActionResponse)
async def start_driver(
    printer_id: int,
    request: Request,
    db: DBSession,
    principal=RequirePermission("printers:update"),
):
    if not _is_primary_worker():
        payload = await _proxy_to_primary(
            request,
            method="POST",
            path=f"/api/v1/printers/{printer_id}/driver/start",
        )
        return DriverActionResponse.model_validate(payload)

    _ensure_primary_worker()

    result = await db.execute(
        select(Printer).where(Printer.id == printer_id, Printer.deleted_at.is_(None))
    )
    printer = result.scalar_one_or_none()

    if not printer:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "not_found", "message": "Printer not found"},
        )

    if printer_id in plugin_manager.drivers:
        return DriverActionResponse(success=True, message="Driver already running")

    started = await plugin_manager.start_printer(printer)
    if not started:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={"code": "start_failed", "message": "Driver could not be started"},
        )

    # Publish health immediately so all workers see the new state
    driver = plugin_manager.drivers.get(printer_id)
    if driver:
        shared_health_store.publish({printer_id: driver.health()})

    return DriverActionResponse(success=True, message="Driver started")


@router.post("/{printer_id}/driver/stop", response_model=DriverActionResponse)
async def stop_driver(
    printer_id: int,
    request: Request,
    db: DBSession,
    principal=RequirePermission("printers:update"),
):
    if not _is_primary_worker():
        payload = await _proxy_to_primary(
            request,
            method="POST",
            path=f"/api/v1/printers/{printer_id}/driver/stop",
        )
        return DriverActionResponse.model_validate(payload)

    _ensure_primary_worker()

    result = await db.execute(
        select(Printer).where(Printer.id == printer_id, Printer.deleted_at.is_(None))
    )
    printer = result.scalar_one_or_none()

    if not printer:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "not_found", "message": "Printer not found"},
        )

    await plugin_manager.stop_printer(printer_id)

    # Clear shared health so secondaries immediately see running=False
    shared_health_store.clear(printer_id)

    return DriverActionResponse(success=True, message="Driver stopped")


# ─── Printer Params Import/Export ─────────────────────────────────────────────


class PrinterParamExportItem(BaseModel):
    param_key: str
    param_value: str | None = None


class PrinterParamsExportData(BaseModel):
    printer_id: int
    printer_name: str
    driver_key: str
    filament_params: dict[int, list[PrinterParamExportItem]]  # filament_id -> params
    spool_params: dict[int, list[PrinterParamExportItem]]  # spool_id -> params


class PrinterParamsImportData(BaseModel):
    filament_params: dict[int, list[PrinterParamExportItem]] = {}
    spool_params: dict[int, list[PrinterParamExportItem]] = {}


@router.get("/{printer_id}/params/export")
async def export_printer_params(
    printer_id: int,
    db: DBSession,
    principal: PrincipalDep,
):
    """Export all printer-specific params for this printer as JSON."""
    result = await db.execute(
        select(Printer).where(Printer.id == printer_id, Printer.deleted_at.is_(None))
    )
    printer = result.scalar_one_or_none()
    if not printer:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "not_found", "message": "Printer not found"},
        )

    from app.models.printer_params import FilamentPrinterParam, SpoolPrinterParam

    # Filament params grouped by filament_id
    result = await db.execute(
        select(FilamentPrinterParam).where(
            FilamentPrinterParam.printer_id == printer_id
        )
    )
    filament_params: dict[int, list[dict]] = {}
    for p in result.scalars().all():
        filament_params.setdefault(p.filament_id, []).append(
            {"param_key": p.param_key, "param_value": p.param_value}
        )

    # Spool params grouped by spool_id
    result = await db.execute(
        select(SpoolPrinterParam).where(SpoolPrinterParam.printer_id == printer_id)
    )
    spool_params: dict[int, list[dict]] = {}
    for p in result.scalars().all():
        spool_params.setdefault(p.spool_id, []).append(
            {"param_key": p.param_key, "param_value": p.param_value}
        )

    return {
        "printer_id": printer.id,
        "printer_name": printer.name,
        "driver_key": printer.driver_key,
        "filament_params": filament_params,
        "spool_params": spool_params,
    }


@router.post("/{printer_id}/params/import")
async def import_printer_params(
    printer_id: int,
    body: PrinterParamsImportData,
    db: DBSession,
    principal=RequirePermission("printers:update"),
):
    """Import printer-specific params from JSON. Upserts all entries."""
    result = await db.execute(
        select(Printer).where(Printer.id == printer_id, Printer.deleted_at.is_(None))
    )
    printer = result.scalar_one_or_none()
    if not printer:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "not_found", "message": "Printer not found"},
        )

    from app.models.printer_params import FilamentPrinterParam, SpoolPrinterParam

    imported_count = 0

    # Import filament params
    for filament_id_str, params in body.filament_params.items():
        filament_id = int(filament_id_str)
        for item in params:
            result = await db.execute(
                select(FilamentPrinterParam).where(
                    FilamentPrinterParam.filament_id == filament_id,
                    FilamentPrinterParam.printer_id == printer_id,
                    FilamentPrinterParam.param_key == item.param_key,
                )
            )
            existing = result.scalar_one_or_none()
            if existing:
                existing.param_value = item.param_value
            else:
                db.add(
                    FilamentPrinterParam(
                        filament_id=filament_id,
                        printer_id=printer_id,
                        param_key=item.param_key,
                        param_value=item.param_value,
                    )
                )
            imported_count += 1

    # Import spool params
    for spool_id_str, params in body.spool_params.items():
        spool_id = int(spool_id_str)
        for item in params:
            result = await db.execute(
                select(SpoolPrinterParam).where(
                    SpoolPrinterParam.spool_id == spool_id,
                    SpoolPrinterParam.printer_id == printer_id,
                    SpoolPrinterParam.param_key == item.param_key,
                )
            )
            existing = result.scalar_one_or_none()
            if existing:
                existing.param_value = item.param_value
            else:
                db.add(
                    SpoolPrinterParam(
                        spool_id=spool_id,
                        printer_id=printer_id,
                        param_key=item.param_key,
                        param_value=item.param_value,
                    )
                )
            imported_count += 1

    await db.commit()
    return {
        "imported": imported_count,
        "message": f"Imported {imported_count} params for printer {printer.name}",
    }
