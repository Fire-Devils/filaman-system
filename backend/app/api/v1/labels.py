"""Labels for clients that cannot run the browser label designer."""

from collections import Counter
from datetime import UTC, datetime, timedelta
from io import BytesIO
from typing import Literal

from anyio import to_thread
from fastapi import APIRouter, HTTPException, Query, Request, Response
from PIL import Image
from pydantic import BaseModel
from sqlalchemy import delete, or_, select
from sqlalchemy.orm import selectinload, undefer

from app.api.deps import (
    DBSession,
    PrincipalDep,
    RequirePermission,
    ensure_any_permission,
)
from app.api.v1.schemas_filament import FilamentDetailResponse
from app.api.v1.schemas_spool import SpoolResponse
from app.api.v1.schemas_system_extra_field import SystemExtraFieldResponse
from app.core.config import MANUFACTURER_LOGO_DIR
from app.models import (
    AppSettings,
    Filament,
    FilamentColor,
    LabelAsset,
    LabelPreset,
    LabelPrintRequest,
    Spool,
    SystemExtraField,
)
from app.services.label_asset_service import (
    MAX_IMAGE_PIXELS,
    LabelAssetValidationError,
    canonicalize_label_image,
    validate_canonical_label_image,
)
from app.services.label_svg_renderer import label_render_slot, render_svg_png

router = APIRouter(prefix="/labels", tags=["labels"])


class LabelPrintRequestResponse(BaseModel):
    id: int
    spool_id: int
    preset_id: int | None


class FilamentPrintRequestResponse(BaseModel):
    id: int
    filament_id: int
    preset_id: int | None


class ScaleLabelPresetResponse(BaseModel):
    id: int
    name: str
    selected: bool
    width_mm: float | None
    height_mm: float | None


async def _selected_preset_id(db: DBSession, user_id: int, preset_type: str = "spool") -> int | None:
    return await db.scalar(
        select(LabelPreset.id)
        .where(
            LabelPreset.user_id == user_id,
            LabelPreset.preset_type == preset_type,
            LabelPreset.selected.is_(True),
        )
        .limit(1)
    )


@router.post("/spool/{spool_id}/print-request", status_code=201, response_model=LabelPrintRequestResponse)
async def request_pc_print(
    spool_id: int,
    db: DBSession,
    preset_id: int | None = Query(None, ge=0),
    principal=RequirePermission("spools:read"),
):
    return await _enqueue_pc_print(db, principal, "spool", spool_id, preset_id)


@router.post("/filament/{filament_id}/print-request", status_code=201, response_model=FilamentPrintRequestResponse)
async def request_filament_pc_print(
    filament_id: int,
    db: DBSession,
    preset_id: int | None = Query(None, ge=0),
    principal=RequirePermission("filaments:read"),
):
    return await _enqueue_pc_print(db, principal, "filament", filament_id, preset_id)


def _print_request_response(print_request: LabelPrintRequest) -> dict:
    target = {"spool_id": print_request.spool_id} if print_request.spool_id is not None else {"filament_id": print_request.filament_id}
    return {"id": print_request.id, **target, "preset_id": print_request.preset_id}


async def _enqueue_pc_print(db, principal, kind: Literal["spool", "filament"], entity_id: int, preset_id: int | None):
    if principal.user_id is None:
        raise HTTPException(status_code=403, detail="Use a user API key for PC print requests")
    model = Spool if kind == "spool" else Filament
    if await db.scalar(select(model.id).where(model.id == entity_id)) is None:
        raise HTTPException(status_code=404, detail=f"{kind.capitalize()} not found")
    if preset_id == 0:
        preset_id = None
    elif preset_id is None:
        preset_id = await _selected_preset_id(db, principal.user_id, kind)
    if preset_id is not None:
        preset = await db.scalar(
            select(LabelPreset).where(
                LabelPreset.id == preset_id,
                LabelPreset.user_id == principal.user_id,
                LabelPreset.preset_type == kind,
            )
        )
        if preset is None:
            raise HTTPException(status_code=404, detail="Label preset not found")
        _validated_preset_size(preset.data)
    await db.execute(
        delete(LabelPrintRequest).where(
            LabelPrintRequest.created_at < datetime.now(UTC) - timedelta(minutes=5)
        )
    )
    print_request = LabelPrintRequest(**{f"{kind}_id": entity_id}, user_id=principal.user_id, preset_id=preset_id)
    db.add(print_request)
    await db.commit()
    await db.refresh(print_request)
    return _print_request_response(print_request)


async def _permitted_print_targets(db, principal):
    permitted = await ensure_any_permission(db, principal, "spools:read", "filaments:read")
    return or_(*(column.is_not(None) for permission, column in (
        ("spools:read", LabelPrintRequest.spool_id),
        ("filaments:read", LabelPrintRequest.filament_id),
    ) if permission in permitted))


@router.get("/print-requests/pending", response_model=LabelPrintRequestResponse | FilamentPrintRequestResponse | None)
async def pending_pc_print(
    db: DBSession,
    principal: PrincipalDep,
):
    if principal.user_id is None:
        raise HTTPException(status_code=403, detail="Use a user session for PC print prompts")
    cutoff = datetime.now(UTC) - timedelta(minutes=5)
    print_request = await db.scalar(
        select(LabelPrintRequest)
        .where(
            LabelPrintRequest.user_id == principal.user_id,
            LabelPrintRequest.created_at >= cutoff,
            await _permitted_print_targets(db, principal),
        )
        .order_by(LabelPrintRequest.id)
        .limit(1)
    )
    if print_request is None:
        return None
    return _print_request_response(print_request)


@router.post("/print-requests/{request_id}/claim", status_code=204)
async def claim_pc_print(
    request_id: int,
    db: DBSession,
    principal: PrincipalDep,
):
    if principal.user_id is None:
        raise HTTPException(status_code=403, detail="Use a user session for PC print prompts")
    claimed = await db.execute(
        delete(LabelPrintRequest)
        .where(
            LabelPrintRequest.id == request_id,
            LabelPrintRequest.user_id == principal.user_id,
            LabelPrintRequest.created_at >= datetime.now(UTC) - timedelta(minutes=5),
            await _permitted_print_targets(db, principal),
        )
        .execution_options(synchronize_session=False)
    )
    if claimed.rowcount != 1:
        raise HTTPException(status_code=409, detail="Print request already claimed or missing")
    await db.commit()
    return Response(status_code=204)


@router.get("/presets", response_model=list[ScaleLabelPresetResponse])
async def list_scale_presets(
    db: DBSession,
    principal: PrincipalDep,
    preset_type: Literal["spool", "filament"] = "spool",
):
    await ensure_any_permission(db, principal, "filaments:read" if preset_type == "filament" else "spools:read")
    if principal.user_id is None:
        raise HTTPException(status_code=403, detail="Use a user API key to select label presets")
    rows = await db.execute(
        select(LabelPreset.id, LabelPreset.name, LabelPreset.selected, LabelPreset.data)
        .where(LabelPreset.user_id == principal.user_id, LabelPreset.preset_type == preset_type)
        .order_by(LabelPreset.name)
    )
    result = []
    for row in rows:
        try:
            width_mm, height_mm = _validated_preset_size(row.data)
        except HTTPException:
            width_mm = height_mm = None
        result.append({"id": row.id, "name": row.name, "selected": row.selected,
                       "width_mm": width_mm, "height_mm": height_mm})
    return result


def _validated_preset_size(data: dict) -> tuple[float, float]:
    if not isinstance(data, dict):
        raise HTTPException(422, "Preset is invalid")
    if data.get("version") == 2:
        design = data.get("design")
        if not isinstance(design, dict) or design.get("version") != 2 or not isinstance(design.get("label"), dict):
            raise HTTPException(422, "Preset design is invalid")
        width, height = (design["label"].get(key) for key in ("widthMm", "heightMm"))
        if any(not isinstance(value, (int, float)) or not low <= value <= high
               for value, low, high in ((width, 20, 300), (height, 10, 200))):
            raise HTTPException(422, "Preset design has invalid dimensions")
        elements = design.get("elements")
        if (
            not isinstance(elements, list)
            or len(elements) > 100
            or any(
                not isinstance(element, dict)
                or not isinstance(element.get("type"), str)
                or element["type"] not in {
                    "text", "qr", "manufacturerLogo", "image", "swatch", "shape",
                }
                for element in elements
            )
        ):
            raise HTTPException(status_code=422, detail="Preset design is invalid")
        return width, height
    raise HTTPException(422, "Legacy or unsupported preset could not be migrated; reopen and save it in the Label Designer")


def _mono1(image: Image.Image, threshold: int = 200) -> bytes:
    width, height = image.size
    row_bytes = (width + 7) // 8
    # PIL stores white as 1; the wire format uses black as 1.
    binary = image.convert("L").point(lambda value: 255 if value >= threshold else 0, mode="1")
    packed = bytearray(binary.tobytes().translate(bytes(range(255, -1, -1))))
    if width % 8:
        mask = (0xFF << (8 - width % 8)) & 0xFF
        for row in range(height):
            packed[row * row_bytes + row_bytes - 1] &= mask
    return bytes(packed)


def _preview_images(assets: dict[str, bytes], logo_path, image_uses: Counter, qr_count: int):
    # ponytail: reserve the shared renderer's maximum 1024² canvas per QR;
    # use exact normalized sizes only if this conservative ceiling becomes limiting.
    pixels = qr_count * 1024 * 1024
    limit_error = "Label images and QR codes exceed the combined 12 megapixel render limit"
    for path, content in assets.items():
        image = validate_canonical_label_image(content)
        # Capture embeds each occurrence, even when its source URL is reused.
        pixels += image.width * image.height * image_uses[path]
    if pixels > MAX_IMAGE_PIXELS:
        raise LabelAssetValidationError(limit_error)
    logo_url = None
    if logo_path is not None:
        try:
            with logo_path.open("rb") as source:
                content = source.read(2_000_001)
        except FileNotFoundError:
            content = None
        if content is not None:
            if len(content) > 2_000_000:
                raise LabelAssetValidationError("Manufacturer logo exceeds 2 MB")
            logo = canonicalize_label_image(content)
            logo_url = "/__label-assets/manufacturer.png"
            pixels += logo.width * logo.height * image_uses[logo_url]
            if pixels > MAX_IMAGE_PIXELS:
                raise LabelAssetValidationError(limit_error)
            assets[logo_url] = logo.content
    return assets, logo_url


def _finish_raster(image, label_width, label_height, width, rotated, align, format, color, preset_id, threshold=200):
    # CSS millimetres round to fractional pixels; make the wire dimensions exact.
    if image.size != (label_width, label_height):
        image = image.resize((label_width, label_height), Image.Resampling.LANCZOS)
    if color == "mono":
        image = image.convert("L").convert("RGB")
    if rotated:
        image = image.transpose(Image.Transpose.ROTATE_90)
        label_width = image.width
    if label_width > width:
        raise HTTPException(status_code=422, detail="Label is wider than the requested print area")
    if label_width < width:
        canvas = Image.new("RGB", (width, image.height), "white")
        canvas.paste(image, (width - label_width if align == "right" else 0, 0))
        image = canvas
    headers = {
        "Cache-Control": "no-store",
        "X-Preset-Id": str(preset_id or 0),
        "X-Image-Width": str(image.width),
        "X-Image-Height": str(image.height),
        "X-Content-Width": str(label_width),
        "X-Rotated": "1" if rotated else "0",
    }
    if format == "mono1":
        headers.update({"X-Row-Bytes": str((image.width + 7) // 8), "X-Bit-Order": "msb-black-1"})
        return Response(_mono1(image, threshold), media_type="application/octet-stream", headers=headers)
    output = BytesIO()
    image.save(output, format="PNG")
    return Response(output.getvalue(), media_type="image/png", headers=headers)


def _decode_raster(png: bytes) -> Image.Image:
    with Image.open(BytesIO(png)) as source:
        if source.width > 2048 or source.height > 2048:
            raise HTTPException(status_code=422, detail="Rendered label exceeds the image limit")
        return source.convert("RGB")


@router.get("/spool/{spool_id}/render", response_class=Response, responses={
    200: {"content": {"image/png": {}, "application/octet-stream": {}}, "description": "Rendered label image"},
})
async def render_spool_label(
    spool_id: int,
    request: Request,
    db: DBSession,
    format: Literal["png", "mono1"] = "png",
    width: int = Query(576, ge=384, le=1024),
    dpi: int | None = Query(None, ge=100, le=600),
    align: Literal["left", "right"] = "left",
    orientation: Literal["original", "landscape", "portrait"] = "original",
    preset_id: int | None = Query(None, ge=0, description="Omit for the selected preset; 0 uses Default for this request"),
    color: Literal["mono", "color"] = "mono",
    threshold: int = Query(200, ge=0, le=255, description="mono1 only: values below this are black; ignored for PNG"),
    principal=RequirePermission("spools:read"),
):
    return await _render_label("spool", spool_id, request, db, format, width, dpi, align,
                               orientation, preset_id, color, threshold, principal)


@router.get("/filament/{filament_id}/render", response_class=Response, responses={
    200: {"content": {"image/png": {}, "application/octet-stream": {}}, "description": "Rendered label image"},
})
async def render_filament_label(
    filament_id: int,
    request: Request,
    db: DBSession,
    format: Literal["png", "mono1"] = "png",
    width: int = Query(576, ge=384, le=1024),
    dpi: int | None = Query(None, ge=100, le=600),
    align: Literal["left", "right"] = "left",
    orientation: Literal["original", "landscape", "portrait"] = "original",
    preset_id: int | None = Query(None, ge=0, description="Omit for the selected preset; 0 uses Default for this request"),
    color: Literal["mono", "color"] = "mono",
    threshold: int = Query(200, ge=0, le=255, description="mono1 only: values below this are black; ignored for PNG"),
    principal=RequirePermission("filaments:read"),
):
    return await _render_label("filament", filament_id, request, db, format, width, dpi, align,
                               orientation, preset_id, color, threshold, principal)


async def _render_label(
    preset_type, entity_id, request, db, format, width, dpi, align,
    orientation, preset_id, color, threshold, principal,
):
    if format == "mono1" and color == "color":
        raise HTTPException(status_code=422, detail="mono1 is always monochrome")
    async with label_render_slot():
        if preset_type == "spool":
            entity = await db.scalar(select(Spool).where(Spool.id == entity_id).options(
                selectinload(Spool.filament).selectinload(Filament.manufacturer),
                selectinload(Spool.filament).selectinload(Filament.filament_colors).selectinload(FilamentColor.color),
                selectinload(Spool.status), selectinload(Spool.location),
            ))
        else:
            entity = await db.scalar(select(Filament).where(Filament.id == entity_id).options(
                selectinload(Filament.manufacturer),
                selectinload(Filament.filament_colors).selectinload(FilamentColor.color),
            ))
        if entity is None:
            raise HTTPException(status_code=404, detail=f"{preset_type.capitalize()} not found")
        filament = entity.filament if preset_type == "spool" else entity
        filament.filament_colors.sort(key=lambda color: color.position)
        if preset_id is None and principal.user_id is not None:
            preset_id = await _selected_preset_id(db, principal.user_id, preset_type)
        preset_id = preset_id or None
        preset_data = None
        design = None
        assets = {}
        width_mm, height_mm = 60, 40
        if preset_id is not None:
            if principal.user_id is None:
                raise HTTPException(status_code=403, detail="Use a user API key to select label presets")
            preset = await db.scalar(
                select(LabelPreset).where(
                    LabelPreset.id == preset_id,
                    LabelPreset.user_id == principal.user_id,
                    LabelPreset.preset_type == preset_type,
                )
            )
            if preset is None:
                raise HTTPException(status_code=404, detail="Label preset not found")
            preset_data = preset.data
            width_mm, height_mm = _validated_preset_size(preset_data)
            design = preset.data.get("design")
            elements = design["elements"]
            asset_ids = set()
            for element in elements:
                if isinstance(element, dict) and element.get("type") == "image":
                    asset_id = element.get("assetId")
                    if not isinstance(asset_id, str) or not asset_id or len(asset_id) > 120:
                        raise HTTPException(status_code=422, detail="Preset image is unavailable")
                    asset_ids.add(asset_id)
            if asset_ids:
                rows = await db.scalars(
                    select(LabelAsset).options(undefer(LabelAsset.content)).where(
                        LabelAsset.id.in_(asset_ids), LabelAsset.user_id == principal.user_id,
                    )
                )
                assets = {asset.id: asset.content for asset in rows}
                if set(assets) != asset_ids:
                    raise HTTPException(status_code=422, detail="Preset image is unavailable")
        rotated = (
            orientation == "landscape" and height_mm > width_mm
        ) or (
            orientation == "portrait" and width_mm > height_mm
        )
        if dpi:
            label_width = round(width_mm * dpi / 25.4)
            label_height = round(height_mm * dpi / 25.4)
        elif rotated:
            label_width = round(width * width_mm / height_mm)
            label_height = width
        else:
            label_width = width
            label_height = round(width * height_mm / width_mm)
        content_width, content_height = (label_height, label_width) if rotated else (label_width, label_height)
        if content_width > width:
            raise HTTPException(status_code=422, detail="Label is wider than the requested print area")
        if content_height > 2048:
            raise HTTPException(status_code=422, detail="Preset is too tall for the requested width")
        if design is not None:
            image_uses = Counter(
                element["assetId"] if element.get("type") == "image" else "/__label-assets/manufacturer.png"
                for element in design["elements"] if element.get("type") in ("image", "manufacturerLogo")
            )
            qr_count = sum(element.get("type") == "qr" for element in design["elements"])
        else:
            image_uses = Counter({"/__label-assets/manufacturer.png": 1})
            qr_count = 1
        logo_path = (
            MANUFACTURER_LOGO_DIR / f"{filament.manufacturer_id}_label.png"
            if image_uses["/__label-assets/manufacturer.png"] else None
        )
        asset_urls = {
            asset_id: f"/__label-assets/{index}.png"
            for index, asset_id in enumerate(assets)
        }
        assets = {asset_urls[asset_id]: content for asset_id, content in assets.items()}
        image_uses = Counter({
            asset_urls.get(path, path): count for path, count in image_uses.items()
        })
        try:
            assets, logo_url = await to_thread.run_sync(
                _preview_images, dict(assets), logo_path, image_uses, qr_count
            )
        except (LabelAssetValidationError, OSError) as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        definitions = {"spool": {}, "filament": {}}
        for field in await db.scalars(select(SystemExtraField).where(SystemExtraField.target_type.in_(definitions))):
            definitions[field.target_type][field.key] = SystemExtraFieldResponse.model_validate(field).model_dump(mode="json")
        if preset_type == "spool":
            entity_data = SpoolResponse.model_validate(entity).model_dump(mode="json")
            entity_data["status"] = {"label": entity.status.label}
            entity_data["location"] = {"name": entity.location.name} if entity.location else None
        else:
            entity_data = FilamentDetailResponse.model_validate(entity).model_dump(mode="json")
        purchase_currency = await db.scalar(select(AppSettings.currency).where(AppSettings.id == 1))
        payload = {
            preset_type: entity_data, "preset": preset_data, "fieldDefinitions": definitions,
            "assets": asset_urls, "logoUrl": logo_url,
            "pixelWidth": label_width, "pixelHeight": label_height,
            "thermal": format == "mono1",
            "purchaseCurrency": purchase_currency or "EUR",
        }
        png = await render_svg_png(payload, str(request.base_url).rstrip("/"), assets)
        image = await to_thread.run_sync(_decode_raster, png)
        return await to_thread.run_sync(
            _finish_raster, image, label_width, label_height, width, rotated, align, format, color, preset_id, threshold,
        )
