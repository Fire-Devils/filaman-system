"""Community-Beiträge an die FilaMan-DB: Token, Einreichen, Abgleich, Druckprofile.

Der Token ist persönlich (je User, verschlüsselt in ``users``). Token verwalten,
Senden, Bewerten und Melden brauchen ``filamentdb:contribute`` (als Dependency im
Funktionskopf) und laufen mit dem Token des aufrufenden Users. Die Liste zeigt
die eigenen Beiträge, mit ``admin:system`` alle. Ein
Community-Profil übernehmen ``filaments:update``. Fehler der FilaMan-DB kommen
mit eigenem Code an die Oberfläche (``filamentdb_token_invalid``,
``daily_limit_reached``, ``implausible_value`` mit ``field`` …); ein ungültiger
Token wird absichtlich nicht als 401 zurückgegeben.
"""

import logging
from collections.abc import Awaitable
from typing import Any, Literal, TypeVar

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import select

from app.api.deps import DBSession, PrincipalDep, RequirePermission, ensure_any_permission, resolve_user_permissions
from app.core.app_secret import encrypt_app_secret
from app.models import FilamentDBContribution, FilamentPrinterProfile, User
from app.models.plugin import InstalledPlugin
from app.services import filamentdb_contribution_service as svc
from app.services.filamentdb_contrib_client import FilamentDBError, fdb_request

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/filamentdb", tags=["FilamentDB Contributions"])

T = TypeVar("T")
EntityType = Literal["manufacturer", "filament", "printer_model", "print_profile"]

_CONTRIBUTE = RequirePermission("filamentdb:contribute")


_LINK_PERMISSION = {
    "manufacturer": "manufacturers:update",
    "filament": "filaments:update",
    "print_profile": "filaments:update",
    "printer_model": "printers:update",
}


async def _guard(coro: Awaitable[T]) -> T:
    try:
        return await coro
    except FilamentDBError as exc:
        raise exc.to_http() from exc


# ── Token (Profileinstellungen, je User) ─────────────────────────────────


class TokenSet(BaseModel):
    token: str = Field(..., min_length=8, max_length=200)


class TokenStatus(BaseModel):
    saved: bool
    display_name: str | None = None
    scopes: list[str] | None = None


async def _own_user(db: DBSession, principal) -> User:
    """Der Token gehört dem eingeloggten User; API-Keys/Geräte ohne User scheitern."""
    user = await svc.get_user(db, principal.user_id)
    if user is None:
        raise HTTPException(
            status_code=400,
            detail={
                "code": "filamentdb_token_user_required",
                "message": "The FilaMan-DB token belongs to a user account",
            },
        )
    return user


@router.get("/token", response_model=TokenStatus)
async def get_token_status(db: DBSession, principal=RequirePermission("filamentdb:contribute")):
    """Nie den Token selbst, nur ob einer gespeichert ist."""
    user = await _own_user(db, principal)
    saved = bool(user.filamentdb_token_enc)
    return TokenStatus(saved=saved, display_name=user.filamentdb_token_name if saved else None)


@router.put("/token", response_model=TokenStatus)
async def set_token(
    data: TokenSet, db: DBSession, principal=RequirePermission("filamentdb:contribute")
):
    user = await _own_user(db, principal)
    token = data.token.strip()
    who = await _guard(fdb_request("GET", "/token/whoami", token=token))
    who = who if isinstance(who, dict) else {}
    user.filamentdb_token_enc = encrypt_app_secret(token)
    user.filamentdb_token_name = who.get("display_name")
    await db.commit()
    return TokenStatus(
        saved=True, display_name=who.get("display_name"), scopes=who.get("scopes")
    )


@router.post("/token/test", response_model=TokenStatus)
async def test_token(db: DBSession, principal=RequirePermission("filamentdb:contribute")):
    user = await _own_user(db, principal)
    token = await _guard(svc.require_token(db, user.id))
    who = await _guard(fdb_request("GET", "/token/whoami", token=token))
    who = who if isinstance(who, dict) else {}
    if who.get("display_name") and who["display_name"] != user.filamentdb_token_name:
        user.filamentdb_token_name = who["display_name"]
        await db.commit()
    return TokenStatus(
        saved=True, display_name=who.get("display_name"), scopes=who.get("scopes")
    )


@router.delete("/token", response_model=TokenStatus)
async def delete_token(db: DBSession, principal=RequirePermission("filamentdb:contribute")):
    user = await _own_user(db, principal)
    user.filamentdb_token_enc = None
    user.filamentdb_token_name = None
    await db.commit()
    return TokenStatus(saved=False)


# ── Status für die Oberfläche ────────────────────────────────────────────


@router.get("/contributions/status")
async def contribution_status(db: DBSession, principal: PrincipalDep):
    """Plugin aktiv und Token des Users gespeichert (Knöpfe nur dann zeigen)."""
    plugin = await db.scalar(
        select(InstalledPlugin).where(InstalledPlugin.plugin_key == "filamentdb_import")
    )
    user = await svc.get_user(db, principal.user_id)
    saved = bool(user and user.filamentdb_token_enc)
    return {
        "plugin_active": bool(plugin and plugin.is_active),
        "token_saved": saved,
        "display_name": user.filamentdb_token_name if saved else None,
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
    return await _guard(svc.preview(db, principal.user_id, data.type, data.local_id))


@router.post("/contributions/submit")
async def submit_contribution(
    data: SubmitRequest, db: DBSession, principal=_CONTRIBUTE
):
    if data.action == "link":
        # Verknüpfen schreibt am lokalen Objekt: dessen Update-Recht ist zusätzlich nötig.
        await ensure_any_permission(db, principal, _LINK_PERMISSION[data.type])
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


async def _sees_all(db: DBSession, principal) -> bool:
    """Wer ``admin:system`` hat, sieht die Beiträge aller User."""
    if principal.is_superadmin:
        return True
    if principal.user_id is None:
        return False
    return "admin:system" in await resolve_user_permissions(db, principal.user_id)


async def _list_for(db: DBSession, principal, stmt) -> dict[str, Any]:
    all_users = await _sees_all(db, principal)
    if not all_users:
        stmt = stmt.where(FilamentDBContribution.created_by == principal.user_id)
    rows = (await db.scalars(stmt.limit(500))).all()
    return {"items": [await svc.serialize(db, row) for row in rows], "all_users": all_users}


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
    return await _list_for(db, principal, stmt)


@router.post("/contributions/refresh")
async def refresh_contributions(db: DBSession, principal=_CONTRIBUTE):
    await _guard(svc.refresh(db, principal.user_id))
    stmt = select(FilamentDBContribution).order_by(FilamentDBContribution.id.desc())
    return await _list_for(db, principal, stmt)


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
        token = await svc.get_token(db, principal.user_id)
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
    token = await _guard(svc.require_token(db, principal.user_id))
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
    token = await _guard(svc.require_token(db, principal.user_id))
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
