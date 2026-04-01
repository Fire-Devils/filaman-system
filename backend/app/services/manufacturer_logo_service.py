import re
import secrets
from pathlib import Path

from app.core.config import settings

ALLOWED_LOGO_SUFFIXES = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"}
CONTENT_TYPE_SUFFIXES = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/svg+xml": ".svg",
}


def get_manufacturer_logos_dir() -> Path:
    logo_dir = Path(settings.manufacturer_logos_dir)
    logo_dir.mkdir(parents=True, exist_ok=True)
    return logo_dir


def slugify_manufacturer_name(name: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    return slug or "manufacturer-logo"


def determine_logo_suffix(filename: str | None, content_type: str | None) -> str:
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
) -> str:
    logo_dir = get_manufacturer_logos_dir()
    safe_name = slugify_manufacturer_name(manufacturer_name)
    suffix = determine_logo_suffix(filename, content_type)
    stored_name = f"{safe_name}-{secrets.token_hex(4)}{suffix}"
    stored_path = logo_dir / stored_name
    stored_path.write_bytes(file_bytes)
    return f"manufacturer-logos/{stored_name}"


def resolve_logo_file_path(stored_path: str) -> Path:
    return get_manufacturer_logos_dir() / Path(stored_path).name


def delete_manufacturer_logo(stored_path: str | None) -> None:
    if not stored_path:
        return
    path = resolve_logo_file_path(stored_path)
    if path.exists():
        path.unlink()