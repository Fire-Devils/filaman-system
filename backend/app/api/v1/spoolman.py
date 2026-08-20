"""Administrative Spoolman import and repair endpoints."""

import logging
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

from fastapi import APIRouter, HTTPException, status
from fastapi.responses import JSONResponse

from app.api.deps import DBSession, RequirePermission
from app.api.v1.schemas_spoolman import (
    RepairExamplePreviewRequest,
    RepairExamplePreviewResponse,
    SpoolmanConnectionResponse,
    SpoolmanExecuteRequest,
    SpoolmanImportResultResponse,
    SpoolmanLegacyImportResultResponse,
    SpoolmanPreviewRequest,
    SpoolmanRepairExecuteRequest,
    SpoolmanRepairPreviewRequest,
    SpoolmanTransparencyRepairRequest,
    SpoolmanTransparencyRepairResultResponse,
    SpoolmanUrlRequest,
)
from app.core.config import DATA_DIR
from app.core.file_lock import FileLockBusy, exclusive_file_lock
from app.services.spoolman_client import SpoolmanClient
from app.services.spoolman_errors import SpoolmanImportError, SpoolmanRepairError
from app.services.spoolman_import_repair_service import SpoolmanImportRepairService
from app.services.spoolman_import_service import SpoolmanImportService

logger = logging.getLogger(__name__)
SPOOLMAN_MUTATION_LOCK_PATH = DATA_DIR / "locks" / "spoolman-mutation.lock"
_PLUGINS_MANAGE_PERMISSION = RequirePermission("admin:plugins_manage")


@contextmanager
def _exclusive_spoolman_mutation() -> Iterator[None]:
    """Reject overlapping Spoolman mutations across Gunicorn workers."""
    try:
        with exclusive_file_lock(SPOOLMAN_MUTATION_LOCK_PATH):
            yield
    except FileLockBusy as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "code": "spoolman_import_in_progress",
                "message": "Another Spoolman import operation is already running",
            },
        ) from exc


router = APIRouter(
    prefix="/admin/system/spoolman-import",
    tags=["admin-system"],
)


@router.post(
    "/test-connection",
    response_model=SpoolmanConnectionResponse,
)
async def spoolman_test_connection(
    body: SpoolmanUrlRequest,
    db: DBSession,
    principal=_PLUGINS_MANAGE_PERMISSION,
):
    """Verbindung zu Spoolman-Instanz testen."""
    service = SpoolmanImportService(db)
    try:
        result = await service.test_connection(body.url)
        return result
    except SpoolmanImportError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"code": exc.code, "message": str(exc)},
        ) from exc


@router.post("/preview")
async def spoolman_preview(
    body: SpoolmanPreviewRequest,
    db: DBSession,
    principal=_PLUGINS_MANAGE_PERMISSION,
):
    """Vorschau der zu importierenden Daten."""
    service = SpoolmanImportService(db)
    try:
        candidate_count: int | None = None
        plan_digest: str | None = None
        if body.include_transparency_repairs:
            preview, candidate_count, plan_digest = (
                await service.preview_with_transparency_repairs(body.url)
            )
        else:
            preview = await service.preview(body.url)

        response: dict[str, Any] = {
            "summary": preview.summary,
            "vendors": preview.vendors,
            "filaments": preview.filaments,
            "spools": preview.spools,
            "locations": preview.locations,
            "colors": preview.colors,
        }
        if body.include_extra_fields:
            response.update(
                {
                    "extra_fields": preview.extra_fields,
                    "extra_field_targets": sorted(preview.available_field_targets),
                    "extra_field_fingerprint": preview.extra_field_fingerprint,
                    "warnings": preview.warnings,
                }
            )
        if body.include_transparency_repairs:
            response.update(
                {
                    "transparency_repair_candidates": candidate_count,
                    "transparency_repair_plan_digest": plan_digest,
                }
            )
        return JSONResponse(response)
    except SpoolmanImportError as exc:
        logger.warning("Spoolman Import Error: %s", exc, exc_info=True)
        return JSONResponse(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            content={"detail": {"code": exc.code, "message": str(exc)}},
        )
    except Exception as exc:
        import traceback

        tb = traceback.format_exc()
        logger.exception("Unexpected error in Spoolman preview: %s", tb)
        return JSONResponse(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            content={
                "detail": {
                    "code": "internal_error",
                    "message": (
                        f"Unerwarteter Fehler: {exc!s}\n\nTraceback:\n{tb}"
                    ),
                    "type": type(exc).__name__,
                }
            },
        )


@router.post("/execute")
async def spoolman_execute(
    body: SpoolmanExecuteRequest,
    db: DBSession,
    principal=_PLUGINS_MANAGE_PERMISSION,
):
    """Spoolman-Import ausfuehren."""
    rich_request = (
        body.include_extra_fields
        or "extra_field_mode" in body.model_fields_set
        or "field_actions" in body.model_fields_set
    )
    if rich_request and not body.extra_field_fingerprint:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={
                "code": "preview_required",
                "message": (
                    "Load a rich-field preview before executing an import with "
                    "extra-field options."
                ),
            },
        )
    with _exclusive_spoolman_mutation():
        service = SpoolmanImportService(db)
        try:
            options: dict[str, Any] = {}
            if "extra_field_mode" in body.model_fields_set:
                options["extra_field_mode"] = body.extra_field_mode
            if "field_actions" in body.model_fields_set:
                options["field_actions"] = body.field_actions
            result = await service.execute(
                body.url,
                body.extra_field_fingerprint,
                **options,
            )
            response_type = (
                SpoolmanImportResultResponse
                if body.include_extra_fields
                else SpoolmanLegacyImportResultResponse
            )
            return response_type.model_validate(result, from_attributes=True)
        except SpoolmanImportError as exc:
            logger.warning(
                "Spoolman Import Execution Error: %s", exc, exc_info=True
            )
            raise HTTPException(
                status_code=(
                    status.HTTP_409_CONFLICT
                    if exc.code == "preview_changed"
                    else status.HTTP_422_UNPROCESSABLE_ENTITY
                ),
                detail={"code": exc.code, "message": str(exc)},
            ) from exc
        except Exception as exc:
            import traceback

            tb = traceback.format_exc()
            logger.exception("Unexpected error in Spoolman import execution: %s", tb)
            return JSONResponse(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                content={
                    "detail": {
                        "code": "internal_error",
                        "message": (
                            f"Unerwarteter Fehler beim Import: {exc!s}\n\n"
                            f"Traceback:\n{tb}"
                        ),
                        "type": type(exc).__name__,
                    }
                },
            )


@router.post(
    "/repair-transparency",
    response_model=SpoolmanTransparencyRepairResultResponse,
)
async def spoolman_repair_transparency(
    body: SpoolmanTransparencyRepairRequest,
    db: DBSession,
    principal=_PLUGINS_MANAGE_PERMISSION,
):
    """Repair linked transparency assignments without running a full import."""
    with _exclusive_spoolman_mutation():
        service = SpoolmanImportService(db)
        try:
            return await service.repair_transparency(
                body.url,
                body.plan_digest,
            )
        except SpoolmanImportError as exc:
            raise HTTPException(
                status_code=(
                    status.HTTP_409_CONFLICT
                    if exc.code == "repair_plan_changed"
                    else status.HTTP_422_UNPROCESSABLE_ENTITY
                ),
                detail={"code": exc.code, "message": str(exc)},
            ) from exc


async def _repair_source_definitions(
    mode: str,
    url: str | None,
) -> tuple[
    dict[str, list[dict[str, Any]]],
    list[str],
    set[str],
]:
    if mode == "offline":
        return {}, [], set()
    if mode != "server" or not url:
        raise SpoolmanRepairError(
            "A Spoolman URL is required in server mode.", "url_required"
        )
    async with SpoolmanClient(url) as client:
        definitions, warnings, available_targets = (
            await client.fetch_field_definitions()
        )
    available_repair_targets = available_targets & {"filament", "spool"}
    if not available_repair_targets:
        raise SpoolmanRepairError(
            "No Spoolman field definitions could be loaded; use offline recovery "
            "instead.",
            "definitions_unavailable",
        )
    return definitions, warnings, available_repair_targets


@router.post("/repair/preview")
async def spoolman_repair_preview(
    body: SpoolmanRepairPreviewRequest,
    db: DBSession,
    principal=_PLUGINS_MANAGE_PERMISSION,
):
    """Preview a non-destructive repair of previously imported extra fields."""
    repair = SpoolmanImportRepairService(db)
    try:
        definitions, warnings, available_targets = await _repair_source_definitions(
            body.mode, body.url
        )
        preview = await repair.preview(body.mode, definitions)
        preview["warnings"] = warnings
        preview["extra_field_targets"] = sorted(available_targets)
        return preview
    except SpoolmanRepairError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"code": exc.code, "message": str(exc)},
        ) from exc


@router.post(
    "/repair/examples",
    response_model=RepairExamplePreviewResponse,
)
async def spoolman_repair_examples(
    body: RepairExamplePreviewRequest,
    principal=_PLUGINS_MANAGE_PERMISSION,
):
    """Preview conversions with the exact rules used during repair execution."""
    return SpoolmanImportRepairService.preview_conversion_examples(
        body.mapping,
        body.samples,
    )


@router.post("/repair/execute")
async def spoolman_repair_execute(
    body: SpoolmanRepairExecuteRequest,
    db: DBSession,
    principal=_PLUGINS_MANAGE_PERMISSION,
):
    """Apply only the extra-field mappings approved from a repair preview."""
    repair = SpoolmanImportRepairService(db)
    try:
        definitions, _warnings, _available_targets = (
            await _repair_source_definitions(body.mode, body.url)
        )
        with _exclusive_spoolman_mutation():
            return await repair.execute(
                body.mode,
                body.preview_fingerprint,
                body.approved_mappings,
                definitions,
            )
    except SpoolmanRepairError as exc:
        http_status = (
            status.HTTP_409_CONFLICT
            if exc.code == "preview_changed"
            else status.HTTP_422_UNPROCESSABLE_ENTITY
        )
        raise HTTPException(
            status_code=http_status,
            detail={"code": exc.code, "message": str(exc)},
        ) from exc
