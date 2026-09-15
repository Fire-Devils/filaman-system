from __future__ import annotations

from fastapi import HTTPException, status


def _explode_multi(values: list[str] | None) -> list[str]:
    if not values:
        return []
    parts: list[str] = []
    for raw in values:
        for piece in raw.split(","):
            item = piece.strip()
            if item:
                parts.append(item)
    return parts


def parse_multi_int(
    values: list[str] | None,
    field_name: str,
    *,
    max_items: int = 50,
) -> list[int]:
    items = _explode_multi(values)
    if len(items) > max_items:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"message": f"{field_name} accepts up to {max_items} values"},
        )

    parsed: list[int] = []
    for item in items:
        try:
            value = int(item) if item.isdigit() else None
        except ValueError:
            value = None
        if value is None:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail={"message": f"Invalid integer value for {field_name}: {item}"},
            )
        parsed.append(value)
    return parsed


def parse_multi_str(
    values: list[str] | None,
    field_name: str,
    *,
    max_items: int = 50,
    max_length: int = 100,
) -> list[str]:
    items = _explode_multi(values)
    if len(items) > max_items:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"message": f"{field_name} accepts up to {max_items} values"},
        )

    parsed: list[str] = []
    for item in items:
        if len(item) > max_length:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail={"message": f"Value too long for {field_name}"},
            )
        parsed.append(item)
    return parsed
