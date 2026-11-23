"""Parsing and storage of ESP firmware images for OTA updates."""

import hashlib
import os
import re
import tempfile
from dataclasses import dataclass
from pathlib import Path

from fastapi import HTTPException, status

from app.core.config import DATA_DIR

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
