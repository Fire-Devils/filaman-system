"""HTTP schemas for the administrative Spoolman import API."""

from typing import Annotated, Any

from pydantic import BaseModel, Field

from app.services.spoolman_contracts import (
    ApprovedRepairMapping,
    ImportStorageMode,
    RepairMode,
    SpoolmanFieldAction,
)


class SpoolmanUrlRequest(BaseModel):
    url: str


class SpoolmanTransparencyRepairRequest(SpoolmanUrlRequest):
    plan_digest: str = Field(pattern=r"^[0-9a-fA-F]{64}$")


class SpoolmanPreviewRequest(SpoolmanUrlRequest):
    include_extra_fields: bool = False
    include_transparency_repairs: bool = False


class SpoolmanExecuteRequest(SpoolmanUrlRequest):
    include_extra_fields: bool = False
    extra_field_fingerprint: str | None = None
    extra_field_mode: ImportStorageMode = ImportStorageMode.LEGACY
    field_actions: list[SpoolmanFieldAction] = Field(default_factory=list)


class SpoolmanConnectionResponse(BaseModel):
    status: str
    url: str
    info: dict[str, Any]


class SpoolmanPreviewResponse(BaseModel):
    summary: dict[str, int]
    vendors: list[dict[str, Any]]
    filaments: list[dict[str, Any]]
    spools: list[dict[str, Any]]
    locations: list[dict[str, Any]]
    colors: list[dict[str, str]]
    extra_fields: list[dict[str, Any]] = Field(default_factory=list)
    extra_field_targets: list[str] = Field(default_factory=list)
    extra_field_fingerprint: str | None = None
    warnings: list[str] = Field(default_factory=list)


class SpoolmanLegacyImportResultResponse(BaseModel):
    manufacturers_created: int
    manufacturers_skipped: int
    locations_created: int
    locations_skipped: int
    colors_created: int
    colors_skipped: int
    filaments_created: int
    filaments_skipped: int
    spools_created: int
    spools_skipped: int
    errors: list[str]
    warnings: list[str]


class SpoolmanImportResultResponse(SpoolmanLegacyImportResultResponse):
    extra_fields_created: int = 0
    extra_fields_reused: int = 0
    extra_fields_conflicted: int = 0
    extra_values_promoted: int = 0
    extra_values_preserved: int = 0
    extra_local_definitions: int = 0


class SpoolmanTransparencyRepairResultResponse(
    SpoolmanLegacyImportResultResponse
):
    color_assignments_repaired: int


class SpoolmanRepairPreviewRequest(BaseModel):
    mode: RepairMode = RepairMode.SERVER
    url: str | None = None


class SpoolmanRepairExecuteRequest(SpoolmanRepairPreviewRequest):
    preview_fingerprint: str
    approved_mappings: list[ApprovedRepairMapping]


class RepairExamplePreviewRequest(BaseModel):
    mapping: ApprovedRepairMapping
    samples: Annotated[list[Any], Field(max_length=3)]


class RepairConversionExample(BaseModel):
    source: Any
    converted: Any


class RepairExamplePreviewResponse(BaseModel):
    conversion_examples: list[RepairConversionExample]
    invalid_sample_indexes: list[int]
