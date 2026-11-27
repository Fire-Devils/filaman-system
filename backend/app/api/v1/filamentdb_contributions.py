"""Community-Beiträge an die FilaMan-DB: Token, Einreichen, Abgleich, Druckprofile.

Berechtigungen: Token verwalten braucht ``admin:system``; Senden, Bewerten und
Melden ``filamentdb:contribute`` (als Dependency im Funktionskopf); ein
Community-Profil übernehmen ``filaments:update``. Fehler der FilaMan-DB kommen
mit eigenem Code an die Oberfläche (``filamentdb_token_invalid``,
``daily_limit_reached``, ``implausible_value`` mit ``field`` …); ein ungültiger
Token wird absichtlich nicht als 401 zurückgegeben.
"""

import logging
from collections.abc import Awaitable
from typing import Any, Literal, TypeVar

from fastapi import APIRouter, Query
from pydantic import BaseModel, Field
from sqlalchemy import select

from app.api.deps import DBSession, PrincipalDep, RequirePermission
from app.core.app_secret import encrypt_app_secret
from app.models import AppSettings, FilamentDBContribution, FilamentPrinterProfile
from app.models.plugin import InstalledPlugin
from app.services import filamentdb_contribution_service as svc
from app.services.filamentdb_contrib_client import FilamentDBError, fdb_request

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/filamentdb", tags=["FilamentDB Contributions"])

T = TypeVar("T")
EntityType = Literal["manufacturer", "filament", "printer_model", "print_profile"]

_CONTRIBUTE = RequirePermission("filamentdb:contribute")


async def _guard(coro: Awaitable[T]) -> T:
    try:
        return await coro
    except FilamentDBError as exc:
        raise exc.to_http() from exc


# ── Token (Systemeinstellungen) ──────────────────────────────────────────


class TokenSet(BaseModel):
    token: str = Field(..., min_length=8, max_length=200)


class TokenStatus(BaseModel):
    saved: bool
    display_name: str | None = None
    scopes: list[str] | None = None


async def _settings_row(db: DBSession) -> AppSettings:
    row = await svc.get_settings_row(db)
    if row is None:
        row = AppSettings(id=1)
        db.add(row)
    return row


@router.get("/token", response_model=TokenStatus)
async def get_token_status(db: DBSession, principal=RequirePermission("admin:system")):
    """Nie den Token selbst, nur ob einer gespeichert ist."""
    row = await svc.get_settings_row(db)
    saved = bool(row and row.filamentdb_token_enc)
    return TokenStatus(saved=saved, display_name=row.filamentdb_token_name if saved else None)


@router.put("/token", response_model=TokenStatus)
async def set_token(
    data: TokenSet, db: DBSession, principal=RequirePermission("admin:system")
):
    token = data.token.strip()
    who = await _guard(fdb_request("GET", "/token/whoami", token=token))
    who = who if isinstance(who, dict) else {}
    row = await _settings_row(db)
    row.filamentdb_token_enc = encrypt_app_secret(token)
    row.filamentdb_token_name = who.get("display_name")
    await db.commit()
    return TokenStatus(
        saved=True, display_name=who.get("display_name"), scopes=who.get("scopes")
    )


@router.post("/token/test", response_model=TokenStatus)
async def test_token(db: DBSession, principal=RequirePermission("admin:system")):
    token = await _guard(svc.require_token(db))
    who = await _guard(fdb_request("GET", "/token/whoami", token=token))
    who = who if isinstance(who, dict) else {}
    row = await _settings_row(db)
    if who.get("display_name") and who["display_name"] != row.filamentdb_token_name:
        row.filamentdb_token_name = who["display_name"]
        await db.commit()
    return TokenStatus(
        saved=True, display_name=who.get("display_name"), scopes=who.get("scopes")
    )


@router.delete("/token", response_model=TokenStatus)
async def delete_token(db: DBSession, principal=RequirePermission("admin:system")):
    row = await svc.get_settings_row(db)
    if row is not None:
        row.filamentdb_token_enc = None
        row.filamentdb_token_name = None
        await db.commit()
    return TokenStatus(saved=False)


# ── Status für die Oberfläche ────────────────────────────────────────────


@router.get("/contributions/status")
async def contribution_status(db: DBSession, principal: PrincipalDep):
    """Plugin aktiv und Token gespeichert (Knöpfe nur dann zeigen)."""
    plugin = await db.scalar(
        select(InstalledPlugin).where(InstalledPlugin.plugin_key == "filamentdb_import")
    )
    row = await svc.get_settings_row(db)
    saved = bool(row and row.filamentdb_token_enc)
    return {
        "plugin_active": bool(plugin and plugin.is_active),
        "token_saved": saved,
        "display_name": row.filamentdb_token_name if saved else None,
    }


# ── Einreichen ───────────────────────────────────────────────────────────


class ContributionRef(BaseModel):
    type: EntityType
    local_id: int = Field(..., gt=0)


class SubmitRequest(ContributionRef):
    action: Literal["submit", "link"] = "submit"
    match_id: int | None = Field(None, gt=0)
    shown_matches: list[dict[str, Any]] = Field(default_factory=list, max_length=20)


@router.post("/contributions/preview")
async def preview_contribution(
    data: ContributionRef, db: DBSession, principal=_CONTRIBUTE
):
    return await _guard(svc.preview(db, data.type, data.local_id))


@router.post("/contributions/submit")
async def submit_contribution(
    data: SubmitRequest, db: DBSession, principal=_CONTRIBUTE
):
    row = await _guard(
        svc.submit(
            db,
            principal.user_id,
            data.type,
            data.local_id,
            action=data.action,
            match_id=data.match_id,
            shown_matches=data.shown_matches,
        )
    )
    return await svc.serialize(db, row)


@router.get("/contributions")
async def list_contributions(
    db: DBSession,
    principal: PrincipalDep,
    entity_type: EntityType | None = None,
    local_id: int | None = Query(None, gt=0),
):
    stmt = select(FilamentDBContribution).order_by(FilamentDBContribution.id.desc())
    if entity_type:
        stmt = stmt.where(FilamentDBContribution.entity_type == entity_type)
    if local_id:
        stmt = stmt.where(FilamentDBContribution.local_id == local_id)
    rows = (await db.scalars(stmt.limit(500))).all()
    return {"items": [await svc.serialize(db, row) for row in rows]}


@router.post("/contributions/refresh")
async def refresh_contributions(db: DBSession, principal=_CONTRIBUTE):
    await _guard(svc.refresh(db))
    rows = (
        await db.scalars(
            select(FilamentDBContribution).order_by(FilamentDBContribution.id.desc()).limit(500)
        )
    ).all()
    return {"items": [await svc.serialize(db, row) for row in rows]}


# ── Community-Druckprofile ───────────────────────────────────────────────


@router.get("/print-profiles")
async def search_print_profiles(
    db: DBSession,
    principal: PrincipalDep,
    filament_id: int = Query(..., gt=0),
    printer_model_id: int | None = Query(None, gt=0),
    nozzle_diameter_mm: float | None = Query(None, gt=0),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
):
    """Öffentlich in der DB; mit gespeichertem Token kommt zusätzlich ``is_own``."""
    params: dict[str, Any] = {"filament_id": filament_id, "page": page, "page_size": page_size}
    if printer_model_id:
        params["printer_model_id"] = printer_model_id
    if nozzle_diameter_mm:
        params["nozzle_diameter_mm"] = nozzle_diameter_mm
    token = None
    try:
        token = await svc.get_token(db)
    except FilamentDBError:
        token = None
    return await _guard(fdb_request("GET", "/print-profiles", token=token, params=params))


class RatingBody(BaseModel):
    stars: int = Field(..., ge=1, le=5)


class ReportBody(BaseModel):
    reason: str = Field(..., min_length=1, max_length=500)


@router.put("/print-profiles/{profile_id}/rating")
async def rate_print_profile(
    profile_id: int,
    data: RatingBody,
    db: DBSession,
    principal=_CONTRIBUTE,
):
    token = await _guard(svc.require_token(db))
    return await _guard(
        fdb_request(
            "PUT", f"/print-profiles/{profile_id}/rating", token=token, json={"stars": data.stars}
        )
    )


@router.post("/print-profiles/{profile_id}/report", status_code=201)
async def report_print_profile(
    profile_id: int,
    data: ReportBody,
    db: DBSession,
    principal=_CONTRIBUTE,
):
    token = await _guard(svc.require_token(db))
    await _guard(
        fdb_request(
            "POST",
            f"/print-profiles/{profile_id}/report",
            token=token,
            json={"reason": data.reason.strip()},
        )
    )
    return {"reported": True}


class ImportProfileBody(BaseModel):
    filament_id: int = Field(..., gt=0)
    printer_id: int = Field(..., gt=0)


@router.post("/print-profiles/{profile_id}/import", status_code=201)
async def import_print_profile(
    profile_id: int,
    data: ImportProfileBody,
    db: DBSession,
    principal=RequirePermission("filaments:update"),
):
    """Community-Profil als lokales Profil für den gewählten Drucker anlegen."""
    profile: FilamentPrinterProfile = await _guard(
        svc.import_community_profile(
            db, principal.user_id, profile_id, data.filament_id, data.printer_id
        )
    )
    return {"id": profile.id, "filament_id": profile.filament_id, "printer_id": profile.printer_id}
