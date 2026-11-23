from datetime import datetime

from fastapi import APIRouter, File, HTTPException, UploadFile, status
from pydantic import BaseModel
from sqlalchemy import select, update

from app.api.deps import DBSession, RequirePermission
from app.models import DeviceFirmware
from app.services import firmware_github
from app.services import firmware_service as fw

router = APIRouter(prefix="/admin/firmware", tags=["admin"])


class FirmwareResponse(BaseModel):
    id: int
    project: str
    version: str
    size: int
    sha256: str
    is_current: bool
    created_at: datetime | None = None

    class Config:
        from_attributes = True


def _not_found() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_404_NOT_FOUND,
        detail={"code": "not_found", "message": "Firmware not found"},
    )


async def _sha_in_use(db, sha256: str, exclude_id: int | None = None) -> bool:
    query = select(DeviceFirmware.id).where(DeviceFirmware.sha256 == sha256)
    if exclude_id is not None:
        query = query.where(DeviceFirmware.id != exclude_id)
    return (await db.execute(query)).first() is not None


@router.get("", response_model=list[FirmwareResponse])
async def list_firmware(
    db: DBSession,
    principal=RequirePermission("admin:devices_manage"),
):
    result = await db.execute(
        select(DeviceFirmware).order_by(DeviceFirmware.project, DeviceFirmware.created_at.desc(), DeviceFirmware.id.desc())
    )
    return list(result.scalars().all())


@router.post("", response_model=FirmwareResponse, status_code=status.HTTP_201_CREATED)
async def upload_firmware(
    db: DBSession,
    file: UploadFile = File(...),
    principal=RequirePermission("admin:devices_manage"),
):
    data = await file.read(fw.MAX_FIRMWARE_BYTES + 1)
    entry, _ = await fw.import_firmware(db, data, skip_identical=False)
    await fw.prune_firmware(db)
    return entry


@router.post("/github-import")
async def github_import(
    db: DBSession,
    principal=RequirePermission("admin:devices_manage"),
):
    try:
        return await firmware_github.import_latest_release(db)
    except firmware_github.GithubUnavailableError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail={"code": "github_unavailable", "message": str(exc)},
        ) from exc


@router.post("/{firmware_id}/current", response_model=FirmwareResponse)
async def set_current_firmware(
    firmware_id: int,
    db: DBSession,
    principal=RequirePermission("admin:devices_manage"),
):
    entry = (
        await db.execute(select(DeviceFirmware).where(DeviceFirmware.id == firmware_id))
    ).scalar_one_or_none()
    if entry is None:
        raise _not_found()
    await db.execute(
        update(DeviceFirmware).where(DeviceFirmware.project == entry.project).values(is_current=False)
    )
    entry.is_current = True
    await db.commit()
    await db.refresh(entry)
    return entry


@router.delete("/{firmware_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_firmware(
    firmware_id: int,
    db: DBSession,
    principal=RequirePermission("admin:devices_manage"),
):
    entry = (
        await db.execute(select(DeviceFirmware).where(DeviceFirmware.id == firmware_id))
    ).scalar_one_or_none()
    if entry is None:
        raise _not_found()
    if entry.is_current:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "firmware_is_current", "message": "Current firmware cannot be deleted"},
        )
    sha = entry.sha256
    await db.delete(entry)
    await db.commit()
    if not await _sha_in_use(db, sha):
        fw.delete_firmware_file(sha)
