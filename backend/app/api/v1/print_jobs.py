"""Print job log with projects.

Reading needs authentication only. Writing needs ``print_jobs:create``,
``print_jobs:update`` or ``print_jobs:delete``. Completing a job books the
consumption through the regular spool service (see print_job_service).
"""

import io
import logging
from datetime import datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, File, HTTPException, Query, UploadFile, status
from fastapi.responses import FileResponse
from PIL import Image, UnidentifiedImageError
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import and_, case, func, select, update

from app.api.deps import DBSession, PrincipalDep, RequirePermission, ensure_any_permission
from app.api.v1.schemas import PaginatedResponse
from app.core.config import DATA_DIR
from app.core.event_bus import event_bus
from app.models import Printer, PrintJob, PrintJobUsage, PrintProject, Spool
from app.services import print_job_service as svc
from app.services.label_asset_service import MAX_INPUT_IMAGE_BYTES

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/print-jobs", tags=["print-jobs"])
router_projects = APIRouter(prefix="/print-projects", tags=["print-jobs"])
router_spool_jobs = APIRouter(prefix="/spools", tags=["print-jobs"])

PRINT_JOB_PHOTO_DIR = DATA_DIR / "print_jobs"
_PHOTO_FORMATS = {"JPEG": ("jpg", "image/jpeg"), "PNG": ("png", "image/png"), "WEBP": ("webp", "image/webp")}

JobStatus = Literal["pending", "completed", "failed", "cancelled"]
JobSource = Literal["manual", "slicer_link", "api"]
Grams = Annotated[float, Field(ge=0, allow_inf_nan=False)]

_CREATE = RequirePermission("print_jobs:create")
_UPDATE = RequirePermission("print_jobs:update")
_DELETE = RequirePermission("print_jobs:delete")
_BOOKING_PERMISSION = "spool_events:create_consumption"


# ------------------------------------------------------------------ schemas


class ProjectCreate(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    description: str | None = None


class ProjectUpdate(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=255)
    description: str | None = None
    is_archived: bool | None = None


class ProjectResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    description: str | None
    is_archived: bool
    created_at: datetime
    updated_at: datetime
    job_count: int = 0
    total_weight_g: float = 0.0
    total_cost: float | None = None


class UsageInput(BaseModel):
    spool_id: int | None = Field(None, ge=1)
    slot_no: int | None = Field(None, ge=0)
    planned_weight_g: Grams = 0


class UsageResponse(BaseModel):
    id: int
    spool_id: int | None
    slot_no: int | None
    planned_weight_g: float
    used_weight_g: float | None
    cost: float | None
    spool_event_id: int | None
    spool_name: str | None = None
    material_type: str | None = None


class JobCreate(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    project_id: int | None = Field(None, ge=1)
    printer_id: int | None = Field(None, ge=1)
    source: JobSource = "manual"
    started_at: datetime | None = None
    finished_at: datetime | None = None
    print_time_s: int | None = Field(None, ge=0)
    notes: str | None = None
    meta: dict[str, Any] | None = None
    usages: list[UsageInput] = Field(default_factory=list, max_length=64)
    complete: bool = False
    success: bool = True


class JobUpdate(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=255)
    project_id: int | None = Field(None, ge=1)
    printer_id: int | None = Field(None, ge=1)
    started_at: datetime | None = None
    finished_at: datetime | None = None
    print_time_s: int | None = Field(None, ge=0)
    notes: str | None = None
    meta: dict[str, Any] | None = None


class UsageOverride(BaseModel):
    usage_id: int
    used_weight_g: Grams


class CompleteRequest(BaseModel):
    success: bool = True
    usages: list[UsageOverride] = Field(default_factory=list)


class JobResponse(BaseModel):
    id: int
    name: str
    project_id: int | None
    project_name: str | None = None
    printer_id: int | None
    printer_name: str | None = None
    status: str
    source: str
    started_at: datetime | None
    finished_at: datetime | None
    print_time_s: int | None
    notes: str | None
    has_photo: bool
    meta: dict[str, Any] | None
    user_id: int | None
    created_at: datetime
    updated_at: datetime
    total_weight_g: float
    total_cost: float | None
    usages: list[UsageResponse]


# ------------------------------------------------------------------ helpers


def _err(code: int, key: str, message: str) -> HTTPException:
    return HTTPException(status_code=code, detail={"code": key, "message": message})


def _spool_name(spool: Spool | None) -> tuple[str | None, str | None]:
    if spool is None or spool.filament is None:
        return None, None
    filament = spool.filament
    parts = [filament.manufacturer.name if filament.manufacturer else None, filament.designation]
    return " ".join(p for p in parts if p), filament.material_type


def _job_response(job: PrintJob, project_name: str | None, printer_name: str | None) -> JobResponse:
    usages = []
    for usage in job.usages:
        name, material = _spool_name(usage.spool)
        usages.append(
            UsageResponse(
                id=usage.id,
                spool_id=usage.spool_id,
                slot_no=usage.slot_no,
                planned_weight_g=usage.planned_weight_g,
                used_weight_g=usage.used_weight_g,
                cost=usage.cost,
                spool_event_id=usage.spool_event_id,
                spool_name=name,
                material_type=material,
            )
        )
    costs = [u.cost for u in job.usages if u.cost is not None]
    return JobResponse(
        id=job.id,
        name=job.name,
        project_id=job.project_id,
        project_name=project_name,
        printer_id=job.printer_id,
        printer_name=printer_name,
        status=job.status,
        source=job.source,
        started_at=job.started_at,
        finished_at=job.finished_at,
        print_time_s=job.print_time_s,
        notes=job.notes,
        has_photo=bool(job.photo_file),
        meta=job.meta,
        user_id=job.user_id,
        created_at=job.created_at,
        updated_at=job.updated_at,
        total_weight_g=sum(
            (u.used_weight_g if u.used_weight_g is not None else u.planned_weight_g) for u in job.usages
        ),
        total_cost=sum(costs) if costs else None,
        usages=usages,
    )


async def _responses(db, jobs: list[PrintJob]) -> list[JobResponse]:
    project_ids = {j.project_id for j in jobs if j.project_id}
    printer_ids = {j.printer_id for j in jobs if j.printer_id}
    projects = {}
    printers = {}
    if project_ids:
        rows = await db.execute(select(PrintProject.id, PrintProject.name).where(PrintProject.id.in_(project_ids)))
        projects = dict(rows.all())
    if printer_ids:
        rows = await db.execute(select(Printer.id, Printer.name).where(Printer.id.in_(printer_ids)))
        printers = dict(rows.all())
    return [_job_response(j, projects.get(j.project_id), printers.get(j.printer_id)) for j in jobs]


async def _load_job(db, job_id: int) -> PrintJob:
    job = await svc.get_job(db, job_id)
    if job is None:
        raise _err(status.HTTP_404_NOT_FOUND, "not_found", "Print job not found")
    return job


async def _check_refs(db, project_id: int | None, printer_id: int | None) -> None:
    if project_id is not None and await db.get(PrintProject, project_id) is None:
        raise _err(status.HTTP_422_UNPROCESSABLE_CONTENT, "invalid_project", "Project not found")
    if printer_id is not None and await db.get(Printer, printer_id) is None:
        raise _err(status.HTTP_422_UNPROCESSABLE_CONTENT, "invalid_printer", "Printer not found")


def _service_error(exc: svc.PrintJobError) -> HTTPException:
    code = status.HTTP_409_CONFLICT if isinstance(exc, svc.PrintJobStateError) else status.HTTP_422_UNPROCESSABLE_CONTENT
    return _err(code, exc.code, str(exc))


async def _reload(db, job_id: int) -> JobResponse:
    job = await _load_job(db, job_id)
    return (await _responses(db, [job]))[0]


def _photo_path(job: PrintJob):
    return PRINT_JOB_PHOTO_DIR / job.photo_file if job.photo_file else None


# ------------------------------------------------------------------ projects


@router_projects.get("", response_model=list[ProjectResponse])
async def list_projects(db: DBSession, principal: PrincipalDep, include_archived: bool = Query(True)):
    query = select(PrintProject).order_by(PrintProject.name)
    if not include_archived:
        query = query.where(PrintProject.is_archived.is_(False))
    projects = (await db.execute(query)).scalars().all()

    closed = PrintJob.status.in_(("completed", "failed"))
    counts = dict(
        (
            await db.execute(
                select(PrintJob.project_id, func.count(PrintJob.id))
                .where(PrintJob.project_id.is_not(None), closed)
                .group_by(PrintJob.project_id)
            )
        ).all()
    )
    sums = {
        row[0]: (row[1] or 0.0, row[2], row[3])
        for row in (
            await db.execute(
                select(
                    PrintJob.project_id,
                    func.sum(PrintJobUsage.used_weight_g),
                    func.sum(PrintJobUsage.cost),
                    func.count(PrintJobUsage.cost),
                )
                .join(PrintJob, PrintJob.id == PrintJobUsage.print_job_id)
                .where(PrintJob.project_id.is_not(None), closed)
                .group_by(PrintJob.project_id)
            )
        ).all()
    }
    result = []
    for project in projects:
        weight, cost, cost_rows = sums.get(project.id, (0.0, None, 0))
        item = ProjectResponse.model_validate(project)
        item.job_count = counts.get(project.id, 0)
        item.total_weight_g = weight
        item.total_cost = cost if cost_rows else None
        result.append(item)
    return result


@router_projects.get("/{project_id}", response_model=ProjectResponse)
async def get_project(project_id: int, db: DBSession, principal: PrincipalDep):
    for item in await list_projects(db, principal, include_archived=True):
        if item.id == project_id:
            return item
    raise _err(status.HTTP_404_NOT_FOUND, "not_found", "Project not found")


@router_projects.post("", response_model=ProjectResponse, status_code=status.HTTP_201_CREATED)
async def create_project(data: ProjectCreate, db: DBSession, principal=_CREATE):
    project = PrintProject(name=data.name.strip(), description=data.description)
    db.add(project)
    await db.commit()
    await db.refresh(project)
    return ProjectResponse.model_validate(project)


@router_projects.patch("/{project_id}", response_model=ProjectResponse)
async def update_project(project_id: int, data: ProjectUpdate, db: DBSession, principal=_UPDATE):
    project = await db.get(PrintProject, project_id)
    if project is None:
        raise _err(status.HTTP_404_NOT_FOUND, "not_found", "Project not found")
    for field in data.model_fields_set:
        value = getattr(data, field)
        if field in ("name", "is_archived") and value is None:
            continue
        setattr(project, field, value.strip() if field == "name" else value)
    await db.commit()
    return await get_project(project_id, db, principal)


@router_projects.delete("/{project_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_project(project_id: int, db: DBSession, principal=_DELETE):
    project = await db.get(PrintProject, project_id)
    if project is None:
        raise _err(status.HTTP_404_NOT_FOUND, "not_found", "Project not found")
    # Jobs stay in the log, only the link goes (done explicitly: SQLite may not enforce ON DELETE).
    await db.execute(update(PrintJob).where(PrintJob.project_id == project_id).values(project_id=None))
    await db.delete(project)
    await db.commit()


# ------------------------------------------------------------------ jobs


@router.get("", response_model=PaginatedResponse[JobResponse])
async def list_jobs(
    db: DBSession,
    principal: PrincipalDep,
    status_filter: JobStatus | None = Query(None, alias="status"),
    project_id: int | None = Query(None),
    printer_id: int | None = Query(None),
    spool_id: int | None = Query(None),
    date_from: datetime | None = Query(None, alias="from"),
    date_to: datetime | None = Query(None, alias="to"),
    pending_first: bool = Query(True),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
):
    when = func.coalesce(PrintJob.started_at, PrintJob.created_at)
    conditions = []
    if status_filter:
        conditions.append(PrintJob.status == status_filter)
    if project_id is not None:
        conditions.append(PrintJob.project_id == project_id)
    if printer_id is not None:
        conditions.append(PrintJob.printer_id == printer_id)
    if spool_id is not None:
        conditions.append(
            PrintJob.id.in_(select(PrintJobUsage.print_job_id).where(PrintJobUsage.spool_id == spool_id))
        )
    if date_from is not None:
        conditions.append(when >= date_from)
    if date_to is not None:
        conditions.append(when <= date_to)
    where = and_(*conditions) if conditions else None

    query = select(PrintJob).options(svc.JOB_LOAD_OPTION)
    count_query = select(func.count(PrintJob.id))
    if where is not None:
        query = query.where(where)
        count_query = count_query.where(where)
    order = [when.desc(), PrintJob.id.desc()]
    if pending_first:
        order.insert(0, case((PrintJob.status == "pending", 0), else_=1))
    query = query.order_by(*order).offset((page - 1) * page_size).limit(page_size)

    jobs = list((await db.execute(query)).scalars().all())
    total = (await db.execute(count_query)).scalar() or 0
    return PaginatedResponse(items=await _responses(db, jobs), page=page, page_size=page_size, total=total)


@router_spool_jobs.get("/{spool_id}/print-jobs", response_model=PaginatedResponse[JobResponse])
async def list_spool_jobs(
    spool_id: int,
    db: DBSession,
    principal: PrincipalDep,
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
):
    if await db.get(Spool, spool_id) is None:
        raise _err(status.HTTP_404_NOT_FOUND, "not_found", "Spool not found")
    return await list_jobs(
        db, principal, spool_id=spool_id, pending_first=False, page=page, page_size=page_size,
        status_filter=None, project_id=None, printer_id=None, date_from=None, date_to=None,
    )


@router.get("/{job_id}", response_model=JobResponse)
async def get_job(job_id: int, db: DBSession, principal: PrincipalDep):
    return await _reload(db, job_id)


@router.post("", response_model=JobResponse, status_code=status.HTTP_201_CREATED)
async def create_job(data: JobCreate, db: DBSession, principal=_CREATE):
    if data.complete:
        # Completing books spool consumption, so it needs the same right as a
        # direct consumption booking.
        await ensure_any_permission(db, principal, _BOOKING_PERMISSION)
    await _check_refs(db, data.project_id, data.printer_id)
    try:
        usages = await svc.build_usages(
            db,
            data.printer_id,
            [svc.UsageInput(u.spool_id, u.slot_no, u.planned_weight_g) for u in data.usages],
        )
    except svc.PrintJobError as exc:
        raise _service_error(exc) from exc
    job = PrintJob(
        name=data.name.strip(),
        project_id=data.project_id,
        printer_id=data.printer_id,
        status="pending",
        source=data.source,
        started_at=data.started_at,
        finished_at=data.finished_at,
        print_time_s=data.print_time_s,
        notes=data.notes,
        meta=data.meta,
        user_id=principal.user_id,
        usages=usages,
    )
    db.add(job)
    await db.commit()
    if data.complete:
        job = await _load_job(db, job.id)
        try:
            await svc.complete_job(db, job, success=data.success, principal=principal)
        except svc.PrintJobError as exc:
            raise _service_error(exc) from exc
        await event_bus.publish({"event": "spools_changed"})
    return await _reload(db, job.id)


@router.patch("/{job_id}", response_model=JobResponse)
async def update_job(job_id: int, data: JobUpdate, db: DBSession, principal=_UPDATE):
    job = await _load_job(db, job_id)
    await _check_refs(db, data.project_id, data.printer_id)
    for field in data.model_fields_set:
        value = getattr(data, field)
        if field == "name":
            if value is None:
                continue
            value = value.strip()
        setattr(job, field, value)
    await db.commit()
    return await _reload(db, job_id)


@router.delete("/{job_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_job(
    job_id: int,
    db: DBSession,
    force: bool = Query(False, description="Also delete a completed/failed job; its spool bookings remain"),
    principal=_DELETE,
):
    job = await _load_job(db, job_id)
    if job.status in ("completed", "failed") and not force:
        raise _err(
            status.HTTP_409_CONFLICT,
            "print_job_has_bookings",
            "Job is completed; deleting it keeps the booked spool consumption. Use force=true to delete anyway.",
        )
    path = _photo_path(job)
    await db.delete(job)
    await db.commit()
    if path is not None:
        path.unlink(missing_ok=True)


@router.post("/{job_id}/complete", response_model=JobResponse)
async def complete_job(job_id: int, data: CompleteRequest, db: DBSession, principal=_UPDATE):
    await ensure_any_permission(db, principal, _BOOKING_PERMISSION)
    job = await _load_job(db, job_id)
    override = {u.usage_id: u.used_weight_g for u in data.usages}
    try:
        await svc.complete_job(db, job, usages_override=override, success=data.success, principal=principal)
    except svc.PrintJobError as exc:
        raise _service_error(exc) from exc
    await event_bus.publish({"event": "spools_changed"})
    return await _reload(db, job_id)


@router.post("/{job_id}/cancel", response_model=JobResponse)
async def cancel_job(job_id: int, db: DBSession, principal=_UPDATE):
    job = await _load_job(db, job_id)
    try:
        await svc.cancel_job(db, job)
    except svc.PrintJobError as exc:
        raise _service_error(exc) from exc
    return await _reload(db, job_id)


@router.post("/{job_id}/photo", response_model=JobResponse)
async def upload_photo(job_id: int, file: Annotated[UploadFile, File()], db: DBSession, principal=_UPDATE):
    job = await _load_job(db, job_id)
    try:
        content = await file.read(MAX_INPUT_IMAGE_BYTES + 1)
    finally:
        await file.close()
    if len(content) > MAX_INPUT_IMAGE_BYTES:
        raise _err(status.HTTP_413_CONTENT_TOO_LARGE, "photo_too_large", "Photo exceeds the 5 MB limit")
    try:
        with Image.open(io.BytesIO(content)) as image:
            image.verify()
            image_format = image.format or ""
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError, SyntaxError) as exc:
        raise _err(status.HTTP_422_UNPROCESSABLE_CONTENT, "invalid_photo", "File is not a valid image") from exc
    if image_format not in _PHOTO_FORMATS:
        raise _err(status.HTTP_422_UNPROCESSABLE_CONTENT, "invalid_photo", "Only JPEG, PNG and WebP photos are allowed")
    extension = _PHOTO_FORMATS[image_format][0]

    PRINT_JOB_PHOTO_DIR.mkdir(parents=True, exist_ok=True)
    old = _photo_path(job)
    filename = f"{job.id}.{extension}"
    (PRINT_JOB_PHOTO_DIR / filename).write_bytes(content)
    if old is not None and old.name != filename:
        old.unlink(missing_ok=True)
    job.photo_file = filename
    await db.commit()
    return await _reload(db, job_id)


@router.get("/{job_id}/photo")
async def get_photo(job_id: int, db: DBSession, principal: PrincipalDep):
    job = await _load_job(db, job_id)
    path = _photo_path(job)
    if path is None or not path.is_file():
        raise _err(status.HTTP_404_NOT_FOUND, "not_found", "Photo not found")
    media_type = next((m for e, m in _PHOTO_FORMATS.values() if path.suffix == f".{e}"), "application/octet-stream")
    return FileResponse(path, media_type=media_type, headers={"Cache-Control": "private, max-age=300"})
