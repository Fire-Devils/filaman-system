"""Shared identity invariants for JSON-backed custom fields."""


_RESERVED_PATH_SEGMENTS = frozenset({"__proto__", "constructor", "prototype"})
_INTEGRATION_RESERVED_ROOTS = frozenset(
    {
        "filamentdb_id",
        "spoolman_extra",
        "spoolman_external_id",
        "spoolman_id",
    }
)


def validate_custom_field_path(path: str) -> None:
    """Reject paths that can mutate prototypes or overwrite integration metadata."""
    segments = path.split(".")
    if any(not segment for segment in segments):
        raise ValueError("custom-field keys cannot contain empty path segments")
    reserved_segments = _RESERVED_PATH_SEGMENTS.intersection(segments)
    if reserved_segments:
        raise ValueError(
            "custom-field keys cannot contain reserved path segments: "
            f"{sorted(reserved_segments)}"
        )
    if segments[0] in _INTEGRATION_RESERVED_ROOTS:
        raise ValueError(
            "custom-field keys cannot use an integration-reserved destination: "
            f"{segments[0]!r}"
        )
