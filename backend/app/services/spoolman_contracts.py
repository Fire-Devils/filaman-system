"""Validated service-layer contracts for Spoolman rich fields."""

from __future__ import annotations

import json
from enum import StrEnum
from typing import Annotated, Any

from pydantic import (
    AfterValidator,
    BaseModel,
    BeforeValidator,
    Field,
    field_validator,
    model_validator,
)

from app.services.extra_field_validation import (
    validate_custom_field_path,
    validate_field_type_config,
)


class SpoolmanTarget(StrEnum):
    FILAMENT = "filament"
    SPOOL = "spool"


class ImportStorageMode(StrEnum):
    LEGACY = "legacy"
    SYSTEM = "system"
    LOCAL = "local"
    PRESERVE = "preserve"


class RepairMode(StrEnum):
    SERVER = "server"
    OFFLINE = "offline"


class RepairStorageAction(StrEnum):
    SYSTEM = "system"
    LOCAL = "local"
    PRESERVE = "preserve"


class RepairFieldType(StrEnum):
    TEXT = "text"
    NUMBER = "number"
    RANGE = "range"
    DROPDOWN = "dropdown"
    MULTISELECT = "multiselect"
    CHECKBOX = "checkbox"
    DATE = "date"
    DATETIME = "datetime"
    URL = "url"
    TEXTAREA = "textarea"


class SpoolmanSourceFieldType(StrEnum):
    TEXT = "text"
    INTEGER = "integer"
    FLOAT = "float"
    INTEGER_RANGE = "integer_range"
    FLOAT_RANGE = "float_range"
    DATETIME = "datetime"
    BOOLEAN = "boolean"
    CHOICE = "choice"
    DATE = "date"
    URL = "url"


def _validate_field_key(value: str) -> str:
    validate_custom_field_path(value)
    return value


def _strip_text(value: Any) -> Any:
    return value.strip() if isinstance(value, str) else value


FieldKey = Annotated[
    str,
    Field(min_length=1, max_length=100, pattern=r"^[A-Za-z0-9_]+$"),
    AfterValidator(_validate_field_key),
]
NonBlankLabel = Annotated[
    str,
    BeforeValidator(_strip_text),
    Field(min_length=1, max_length=200),
]
DefaultValue = Annotated[str | None, Field(max_length=500)]


class SpoolmanFieldAction(BaseModel):
    target_type: SpoolmanTarget
    key: FieldKey
    action: ImportStorageMode


class SpoolmanFieldCandidate(BaseModel):
    target_type: SpoolmanTarget
    key: FieldKey
    label: NonBlankLabel
    field_type: RepairFieldType
    options: list[str] | None = None
    config: dict[str, Any] | None = None
    default_value: DefaultValue = None
    source_field_type: SpoolmanSourceFieldType | None = None
    order: int = 0

    @field_validator("options")
    @classmethod
    def normalize_options(cls, value: list[str] | None) -> list[str] | None:
        if value is None:
            return None
        return list(dict.fromkeys(item.strip() for item in value if item.strip()))

    @model_validator(mode="after")
    def validate_type_configuration(self) -> SpoolmanFieldCandidate:
        validate_field_type_config(self.field_type.value, self.options, self.config)
        if self.field_type in {
            RepairFieldType.DROPDOWN,
            RepairFieldType.MULTISELECT,
        } and not self.options:
            raise ValueError("dropdown and multiselect mappings require choices")
        if (
            self.field_type is RepairFieldType.DROPDOWN
            and self.default_value is not None
        ):
            normalized_default = self.default_value.strip()
            if normalized_default not in (self.options or []):
                raise ValueError("dropdown default must be one of its choices")
            self.default_value = normalized_default
        if (
            self.field_type is RepairFieldType.MULTISELECT
            and self.default_value is not None
        ):
            try:
                defaults = json.loads(self.default_value)
            except json.JSONDecodeError as exc:
                raise ValueError("multiselect default must be a JSON list") from exc
            if not isinstance(defaults, list) or not all(
                isinstance(item, str) for item in defaults
            ):
                raise ValueError("multiselect defaults must be choices")
            normalized_defaults = list(
                dict.fromkeys(item.strip() for item in defaults if item.strip())
            )
            if any(item not in (self.options or []) for item in normalized_defaults):
                raise ValueError("multiselect defaults must be choices")
            self.default_value = json.dumps(
                normalized_defaults, separators=(",", ":")
            )
        return self


class ApprovedRepairMapping(SpoolmanFieldCandidate):
    action: RepairStorageAction = RepairStorageAction.SYSTEM

    def as_candidate(self) -> SpoolmanFieldCandidate:
        return SpoolmanFieldCandidate.model_validate(
            self.model_dump(exclude={"action"})
        )
