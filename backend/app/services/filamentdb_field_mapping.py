import re
from pathlib import PurePath
from typing import Any

from app.services.extra_field_validation import normalize_numeric_range

DIRECT_FIELDS = {
    "sku": "manufacturer_sku",
    "datasheet_url": "datasheet_url",
    "dry_temp": "drying_temp_c",
    "dry_time_hours": "drying_time_hours",
    "softening_temp": "softening_temp_c",
    "chamber_temp": "chamber_temp_c",
    "max_volumetric_speed": "max_volumetric_speed_mm3_s",
    "flow_ratio": "flow_ratio",
    "k_value": "pressure_advance_k",
    "currency": "price_currency",
}


def normalize_spool_image_file(value: Any) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str) or len(value) > 500 or '..' in value or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]*', value):
        raise ValueError('Invalid spool image filename')
    return value


def _list_value(value: Any) -> list[str] | None:
    if isinstance(value, str):
        values = [item.strip() for item in value.split(",") if item.strip()]
    elif isinstance(value, list):
        values = [str(item).strip() for item in value if str(item).strip()]
    else:
        return None
    return values or None


def standard_filamentdb_fields(
    data: dict[str, Any], *, base_url: str | None = None
) -> dict[str, Any]:
    fields: dict[str, Any] = {}
    profile = data.get('spool_profile')
    if not isinstance(profile, dict) and 'spool_profile_image_file' in data:
        profile = {'id': data.get('spool_profile_id'), 'image_file': data['spool_profile_image_file']}
    if isinstance(profile, dict):
        profile_id = profile.get('id')
        if type(profile_id) is int and profile_id > 0:
            fields['filamentdb_spool_profile_id'] = profile_id
        elif profile_id is None:
            fields['filamentdb_spool_profile_id'] = None
    if isinstance(profile, dict) and 'image_file' in profile:
        try:
            fields['filamentdb_spool_image_file'] = normalize_spool_image_file(profile['image_file'])
        except ValueError:
            fields['filamentdb_spool_image_file'] = None
    for source, target in DIRECT_FIELDS.items():
        value = data.get(source)
        if value is None:
            continue
        # Catalog casing varies; native responses require three uppercase letters.
        if target == "price_currency":
            if not isinstance(value, str):
                continue
            value = value.strip().upper()
            if not re.fullmatch(r"[A-Z]{3}", value):
                continue
        fields[target] = value

    if data.get("image_url"):
        fields["image_url"] = data["image_url"]
    elif data.get("image_file") and base_url:
        filename = PurePath(str(data["image_file"])).name
        fields["image_url"] = f"{base_url.rstrip('/')}/uploads/filaments/{filename}"

    if data.get("discontinued") is not None:
        fields["is_discontinued"] = bool(data["discontinued"])

    fan = {"min": data.get("fan_speed_min"), "max": data.get("fan_speed_max")}
    if fan != {"min": None, "max": None}:
        try:
            normalized_fan = normalize_numeric_range(fan)
            if all(
                endpoint is None or 0 <= endpoint <= 100
                for endpoint in normalized_fan.values()
            ):
                fields["cooling_fan_range_percent"] = normalized_fan
        except ValueError:
            pass

    for source, target in (
        ("ams_compatible", "ams_compatibility"),
        ("build_plates", "build_plate_compatibility"),
    ):
        values = _list_value(data.get(source))
        if values is not None:
            fields[target] = values

    return fields
