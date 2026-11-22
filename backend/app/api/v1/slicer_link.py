"""Slicer-Link: a post-processing script reports sliced jobs to FilaMan.

The script (app/slicer_link/filaman_slicer_link.py) posts the filament usage
of a freshly sliced G-code file. FilaMan creates a pending print job, which is
confirmed on the print job page when the print is done.

Slot rule: filament index ``i`` (T0, T1, ...) goes to the i-th active slot of the
printer ordered by ``slot_no`` unless ``slot_map`` names a slot_no explicitly.
"""

import json
import logging
import math
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Annotated, Any

from fastapi import APIRouter, HTTPException, status
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from sqlalchemy import select

from app.api.deps import DBSession, PrincipalDep, RequirePermission
from app.core.config import DATA_DIR
from app.models import Printer, PrinterSlot, PrintJob
from app.services import print_job_service as svc

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/slicer-link", tags=["slicer-link"])

SCRIPT_PATH = Path(__file__).resolve().parents[2] / "slicer_link" / "filaman_slicer_link.py"
CONTACTS_FILE = DATA_DIR / "slicer_link_contacts.json"

DEFAULT_DENSITY_G_CM3 = 1.24
DEFAULT_DIAMETER_MM = 1.75
RECENT_JOBS = 10

_CREATE = RequirePermission("print_jobs:create")
Positive = Annotated[float, Field(ge=0, allow_inf_nan=False)]


# ------------------------------------------------------------------ helpers


def script_version() -> str:
    try:
        match = re.search(r'^SCRIPT_VERSION\s*=\s*"([^"]+)"', SCRIPT_PATH.read_text(encoding="utf-8"), re.M)
    except OSError:
        return "0"
    return match.group(1) if match else "0"


def _version_tuple(value: str | None) -> tuple[int, ...]:
    return tuple(int(p) for p in re.findall(r"\d+", value or "")) or (0,)


def update_available(client_version: str | None) -> bool:
    return bool(client_version) and _version_tuple(client_version) < _version_tuple(script_version())


def _load_contacts() -> dict[str, Any]:
    try:
        data = json.loads(CONTACTS_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _remember_contact(printer_id: int | None, version: str | None, kind: str) -> None:
    """Persist the last contact per printer (no migration: small JSON file)."""
    try:
        contacts = _load_contacts()
        contacts[str(printer_id or 0)] = {
            "at": datetime.now(timezone.utc).isoformat(),
            "script_version": version,
            "kind": kind,
        }
        CONTACTS_FILE.parent.mkdir(parents=True, exist_ok=True)
        tmp = CONTACTS_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(contacts), encoding="utf-8")
        os.replace(tmp, CONTACTS_FILE)
    except OSError:
        logger.warning("Could not store Slicer-Link contact", exc_info=True)


def grams_from_length(length_mm: float, density_g_cm3: float | None, diameter_mm: float | None) -> float:
    density = density_g_cm3 if density_g_cm3 and density_g_cm3 > 0 else DEFAULT_DENSITY_G_CM3
    diameter = diameter_mm if diameter_mm and diameter_mm > 0 else DEFAULT_DIAMETER_MM
    radius_cm = diameter / 20.0
    return math.pi * radius_cm**2 * (length_mm / 10.0) * density


def _err(code: int, key: str, message: str) -> HTTPException:
    return HTTPException(status_code=code, detail={"code": key, "message": message})


# ------------------------------------------------------------------ schemas


class FilamentIn(BaseModel):
    index: int = Field(ge=0, le=63)
    weight_g: Positive | None = None
    length_mm: Positive | None = None
    material: str | None = Field(None, max_length=50)
    color_hex: str | None = Field(None, max_length=9)


class JobIn(BaseModel):
    printer_id: int = Field(ge=1)
    job_name: str = Field(min_length=1, max_length=255)
    slicer: str = Field(max_length=50)
    slicer_version: str | None = Field(None, max_length=50)
    print_time_s: int | None = Field(None, ge=0)
    filaments: list[FilamentIn] = Field(max_length=64)
    script_version: str | None = Field(None, max_length=20)
    # Optional explicit mapping: filament index -> slot_no of the printer.
    slot_map: dict[int, int] | None = None


class PingIn(BaseModel):
    printer_id: int | None = Field(None, ge=1)
    script_version: str | None = Field(None, max_length=20)


# ------------------------------------------------------------------ endpoints


@router.post("/ping")
async def ping(data: PingIn, db: DBSession, principal=_CREATE):
    if data.printer_id is not None and await db.get(Printer, data.printer_id) is None:
        raise _err(status.HTTP_422_UNPROCESSABLE_CONTENT, "invalid_printer", "Printer not found")
    _remember_contact(data.printer_id, data.script_version, "ping")
    return {
        "ok": True,
        "latest_script_version": script_version(),
        "update_available": update_available(data.script_version),
    }


@router.post("/jobs", status_code=status.HTTP_201_CREATED)
async def ingest_job(data: JobIn, db: DBSession, principal=_CREATE):
    printer = await db.get(Printer, data.printer_id)
    if printer is None or printer.deleted_at is not None:
        raise _err(status.HTTP_422_UNPROCESSABLE_CONTENT, "invalid_printer", "Printer not found")

    slots = (
        await db.scalars(
            select(PrinterSlot)
            .where(PrinterSlot.printer_id == printer.id, PrinterSlot.is_active.is_(True))
            .order_by(PrinterSlot.slot_no)
        )
    ).all()
    slot_numbers = [slot.slot_no for slot in slots]
    explicit = data.slot_map or {}

    mapping: list[dict[str, Any]] = []
    inputs: list[svc.UsageInput] = []
    for item in sorted(data.filaments, key=lambda f: f.index):
        slot_no: int | None = explicit.get(item.index)
        if slot_no is None and item.index < len(slot_numbers):
            slot_no = slot_numbers[item.index]
        if slot_no is not None and slot_no not in slot_numbers:
            slot_no = None  # explicit slot does not exist on this printer

        spool = None
        reason = None
        if slot_no is None:
            reason = "no_slot"
        else:
            spool = await svc.resolve_spool_for_slot(db, printer.id, slot_no)
            if spool is None:
                reason = "slot_empty"

        weight = item.weight_g or 0.0
        if weight <= 0 and item.length_mm:
            filament = spool.filament if spool is not None else None
            weight = grams_from_length(
                item.length_mm,
                filament.density_g_cm3 if filament else None,
                filament.diameter_mm if filament else None,
            )
        weight = round(weight, 2)
        if weight <= 0:
            continue

        inputs.append(svc.UsageInput(spool_id=spool.id if spool else None, slot_no=slot_no, planned_weight_g=weight))
        mapping.append(
            {
                "index": item.index,
                "slot_no": slot_no,
                "spool_id": spool.id if spool else None,
                "reason": reason,
                "weight_g": weight,
                "material": item.material,
                "color_hex": item.color_hex,
            }
        )

    if not inputs:
        raise _err(status.HTTP_422_UNPROCESSABLE_CONTENT, "no_filament_usage", "No filament usage above 0 g")

    try:
        usages = await svc.build_usages(db, printer.id, inputs)
    except svc.PrintJobError as exc:
        raise _err(status.HTTP_422_UNPROCESSABLE_CONTENT, exc.code, str(exc)) from exc

    job = PrintJob(
        name=data.job_name.strip() or "Slicer job",
        printer_id=printer.id,
        status="pending",
        source="slicer_link",
        print_time_s=data.print_time_s,
        meta={
            "slicer": data.slicer,
            "slicer_version": data.slicer_version,
            "script_version": data.script_version,
            "slot_map_explicit": bool(explicit),
            "mapping": mapping,
        },
        user_id=principal.user_id,
        usages=usages,
    )
    db.add(job)
    await db.commit()
    _remember_contact(printer.id, data.script_version, "job")
    return {
        "job_id": job.id,
        "mapping": mapping,
        "latest_script_version": script_version(),
        "update_available": update_available(data.script_version),
    }


@router.get("/status")
async def slicer_link_status(db: DBSession, principal: PrincipalDep):
    contacts = _load_contacts()
    printers = (
        await db.scalars(select(Printer).where(Printer.deleted_at.is_(None), Printer.is_active.is_(True)).order_by(Printer.name))
    ).all()
    result = []
    for printer in printers:
        contact = contacts.get(str(printer.id)) or {}
        slots = (
            await db.scalars(
                select(PrinterSlot)
                .where(PrinterSlot.printer_id == printer.id, PrinterSlot.is_active.is_(True))
                .order_by(PrinterSlot.slot_no)
            )
        ).all()
        result.append(
            {
                "printer_id": printer.id,
                "printer_name": printer.name,
                "last_contact_at": contact.get("at"),
                "script_version": contact.get("script_version"),
                "update_available": update_available(contact.get("script_version")),
                "slots": [{"index": i, "slot_no": s.slot_no, "name": s.name} for i, s in enumerate(slots)],
            }
        )
    jobs = (
        await db.scalars(
            select(PrintJob).where(PrintJob.source == "slicer_link").order_by(PrintJob.id.desc()).limit(RECENT_JOBS)
        )
    ).all()
    return {
        "latest_script_version": script_version(),
        "printers": result,
        "recent_jobs": [
            {
                "id": j.id,
                "name": j.name,
                "printer_id": j.printer_id,
                "status": j.status,
                "created_at": j.created_at.isoformat() if j.created_at else None,
            }
            for j in jobs
        ],
    }


@router.get("/script")
async def download_script(principal: PrincipalDep):
    if not SCRIPT_PATH.is_file():
        raise _err(status.HTTP_404_NOT_FOUND, "not_found", "Script not available")
    return FileResponse(SCRIPT_PATH, media_type="text/x-python", filename="filaman_slicer_link.py")
