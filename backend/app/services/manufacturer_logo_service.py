import re
import secrets
from pathlib import Path

from app.core.config import settings

LOGO_PATH_PREFIX = "manufacturer-logos/"
MAX_LOGO_SIZE_BYTES = 5 * 1024 * 1024

ALLOWED_LOGO_SUFFIXES = {".png", ".jpg", ".jpeg", ".gif", ".webp"}
CONTENT_TYPE_SUFFIXES = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
}


def get_manufacturer_logos_dir() -> Path:
    logo_dir = Path(settings.manufacturer_logos_dir)
    logo_dir.mkdir(parents=True, exist_ok=True)
    return logo_dir


def slugify_manufacturer_name(name: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    return slug or "manufacturer-logo"


def sniff_logo_suffix(file_bytes: bytes) -> str | None:
    if file_bytes.startswith(b"\x89PNG\r\n\x1a\n"):
        return ".png"
    if file_bytes.startswith(b"\xff\xd8\xff"):
        return ".jpg"
    if file_bytes.startswith((b"GIF87a", b"GIF89a")):
        return ".gif"
    if len(file_bytes) >= 12 and file_bytes.startswith(b"RIFF") and file_bytes[8:12] == b"WEBP":
        return ".webp"
    return None


def determine_logo_suffix(
    filename: str | None,
    content_type: str | None,
    detected_suffix: str | None = None,
) -> str:
    if detected_suffix in ALLOWED_LOGO_SUFFIXES:
        return detected_suffix
    if filename:
        suffix = Path(filename).suffix.lower()
        if suffix in ALLOWED_LOGO_SUFFIXES:
            return suffix
    if content_type in CONTENT_TYPE_SUFFIXES:
        return CONTENT_TYPE_SUFFIXES[content_type]
    return ".png"


def save_manufacturer_logo(
    *,
    manufacturer_name: str,
    file_bytes: bytes,
    filename: str | None,
    content_type: str | None,
    detected_suffix: str | None = None,
) -> str:
    logo_dir = get_manufacturer_logos_dir()
    safe_name = slugify_manufacturer_name(manufacturer_name)
    suffix = determine_logo_suffix(filename, content_type, detected_suffix)
    stored_name = f"{safe_name}-{secrets.token_hex(4)}{suffix}"
    stored_path = logo_dir / stored_name
    stored_path.write_bytes(file_bytes)
    return f"{LOGO_PATH_PREFIX}{stored_name}"


def validate_stored_logo_path(stored_path: str) -> str:
    normalized = (stored_path or "").strip().lstrip("/")
    if not normalized.startswith(LOGO_PATH_PREFIX):
        raise ValueError(f"Invalid manufacturer logo path: {stored_path!r}")

    filename = Path(normalized).name
    if not filename or filename in {".", ".."}:
        raise ValueError(f"Invalid manufacturer logo filename: {stored_path!r}")

    if normalized != f"{LOGO_PATH_PREFIX}{filename}":
        raise ValueError(f"Unexpected nested manufacturer logo path: {stored_path!r}")

    if Path(filename).suffix.lower() not in ALLOWED_LOGO_SUFFIXES:
        raise ValueError(f"Unsupported manufacturer logo suffix: {stored_path!r}")

    return filename


def resolve_logo_file_path(stored_path: str) -> Path:
    filename = validate_stored_logo_path(stored_path)
    return get_manufacturer_logos_dir() / filename


def delete_manufacturer_logo(stored_path: str | None) -> None:
    if not stored_path:
        return
    path = resolve_logo_file_path(stored_path)
    if path.exists():
        path.unlink()