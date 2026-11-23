"""Parsing and storage of ESP firmware images for OTA updates."""

import hashlib
import logging
import os
import re
import tempfile
from dataclasses import dataclass
from pathlib import Path

from fastapi import HTTPException, status
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import DATA_DIR
from app.models import AppSettings, DeviceFirmware

logger = logging.getLogger(__name__)

MAX_FIRMWARE_BYTES = 2_097_152
ESP_IMAGE_MAGIC = 0xE9
_MARKER_RE = re.compile(rb"FMFWINFO1:project=([a-z0-9-]{1,64});version=([0-9A-Za-z.+-]{1,32});")
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")


@dataclass(frozen=True)
class FirmwareInfo:
    project: str
    version: str
    size: int
    sha256: str


def firmware_dir() -> Path:
    return DATA_DIR / "firmware"


def firmware_path(sha256: str) -> Path:
    if not SHA256_RE.match(sha256):
        raise ValueError("invalid sha256")
    return firmware_dir() / f"{sha256}.bin"


def _invalid(message: str) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_400_BAD_REQUEST,
        detail={"code": "invalid_firmware", "message": message},
    )


def parse_firmware(data: bytes) -> FirmwareInfo:
    if len(data) > MAX_FIRMWARE_BYTES:
        raise HTTPException(
            status_code=413,
            detail={"code": "firmware_too_large", "message": "Firmware image exceeds 2 MB"},
        )
    if not data or data[0] != ESP_IMAGE_MAGIC:
        raise _invalid("Not an ESP firmware image (first byte must be 0xE9)")
    match = _MARKER_RE.search(data)
    if not match:
        raise _invalid("Firmware contains no FMFWINFO1 project/version marker")
    return FirmwareInfo(
        project=match.group(1).decode("ascii"),
        version=match.group(2).decode("ascii"),
        size=len(data),
        sha256=hashlib.sha256(data).hexdigest(),
    )


def store_firmware_file(sha256: str, data: bytes) -> None:
    """Write atomically (temp file + rename)."""
    target = firmware_path(sha256)
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(dir=target.parent, suffix=".tmp")
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
        os.replace(tmp_name, target)
    except BaseException:
        Path(tmp_name).unlink(missing_ok=True)
        raise


def delete_firmware_file(sha256: str) -> None:
    try:
        firmware_path(sha256).unlink(missing_ok=True)
    except ValueError:
        pass


async def _sha_in_use(db: AsyncSession, sha256: str) -> bool:
    query = select(DeviceFirmware.id).where(DeviceFirmware.sha256 == sha256)
    return (await db.execute(query)).first() is not None


async def import_firmware(
    db: AsyncSession, data: bytes, *, skip_identical: bool = True
) -> tuple[DeviceFirmware, str]:
    """Store an image and register it. Status: imported | replaced | exists.

    With ``skip_identical`` an already stored identical image of the same
    project+version is left untouched (is_current included). Without it the
    entry is (re-)activated as current, as for a manual upload.
    Raises HTTPException 400/413 for invalid images and 409 when the same
    image is stored under another project/version.
    """
    info = parse_firmware(data)
    existing = (
        await db.execute(
            select(DeviceFirmware).where(
                DeviceFirmware.project == info.project, DeviceFirmware.version == info.version
            )
        )
    ).scalar_one_or_none()
    same_sha = (
        await db.execute(select(DeviceFirmware).where(DeviceFirmware.sha256 == info.sha256))
    ).scalar_one_or_none()
    if same_sha is not None and (existing is None or same_sha.id != existing.id):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "code": "firmware_exists",
                "message": f"Identical image already stored as {same_sha.project} {same_sha.version}",
            },
        )
    if skip_identical and existing is not None and existing.sha256 == info.sha256:
        return existing, "exists"

    store_firmware_file(info.sha256, data)
    old_sha: str | None = None
    if existing is None:
        entry = DeviceFirmware(project=info.project, version=info.version, size=info.size, sha256=info.sha256)
        db.add(entry)
        result = "imported"
    else:
        entry = existing
        if entry.sha256 != info.sha256:
            old_sha = entry.sha256
        entry.size = info.size
        entry.sha256 = info.sha256
        result = "replaced"
    await db.flush()
    await db.execute(
        update(DeviceFirmware).where(DeviceFirmware.project == info.project).values(is_current=False)
    )
    entry.is_current = True
    await db.commit()
    await db.refresh(entry)
    if old_sha and not await _sha_in_use(db, old_sha):
        delete_firmware_file(old_sha)
    return entry, result


async def prune_firmware(db: AsyncSession) -> int:
    """Delete old images if ``firmware_keep_latest_only`` is on; return the number removed.

    Per project the current image and the highest other version are kept. Projects
    without a current image are left alone.
    """
    from app.services.plugin_service import version_key

    row = (await db.execute(select(AppSettings).where(AppSettings.id == 1))).scalar_one_or_none()
    if row is None or not row.firmware_keep_latest_only:
        return 0
    entries = list((await db.execute(select(DeviceFirmware))).scalars().all())
    by_project: dict[str, list[DeviceFirmware]] = {}
    for entry in entries:
        by_project.setdefault(entry.project, []).append(entry)
    doomed: list[DeviceFirmware] = []
    for project, items in by_project.items():
        current = next((e for e in items if e.is_current), None)
        if current is None:
            continue
        others = [e for e in items if e.id != current.id]
        if not others:
            continue
        keep = max(others, key=lambda e: (version_key(e.version), e.id))
        doomed.extend(e for e in others if e.id != keep.id)
    if not doomed:
        return 0
    doomed_ids = {e.id for e in doomed}
    kept_shas = {e.sha256 for e in entries if e.id not in doomed_ids}
    for entry in doomed:
        logger.info("Pruning firmware %s %s", entry.project, entry.version)
        await db.delete(entry)
    await db.commit()
    for sha in {e.sha256 for e in doomed} - kept_shas:
        delete_firmware_file(sha)
    return len(doomed)
