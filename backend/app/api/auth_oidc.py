from base64 import urlsafe_b64encode
from datetime import datetime, timedelta
import hashlib
import secrets

import httpx
from fastapi import APIRouter, HTTPException, Request, status
from fastapi.responses import RedirectResponse
from jose import jwt
from sqlalchemy import delete, select, update

from app.api.deps import DBSession
from app.core.config import settings
from app.core.oidc_crypto import decrypt_secret
from app.core.security import generate_token_secret, hash_password_async
from app.models import OIDCAuthState, OIDCSettings, OAuthIdentity, User, UserSession

router = APIRouter(prefix="/auth/oidc", tags=["auth"])


def _build_code_challenge(code_verifier: str) -> str:
    digest = hashlib.sha256(code_verifier.encode()).digest()
    return urlsafe_b64encode(digest).rstrip(b"=").decode()


def _is_expired(created_at: datetime, ttl_minutes: int = 10) -> bool:
    return created_at < datetime.utcnow() - timedelta(minutes=ttl_minutes)


async def _load_settings(db: DBSession) -> OIDCSettings:
    result = await db.execute(select(OIDCSettings).where(OIDCSettings.id == 1))
    settings_row = result.scalar_one_or_none()
    if settings_row is None:
        raise ValueError("Missing OIDC settings")
    if not settings_row.enabled:
        raise ValueError("OIDC is disabled")
    if not settings_row.issuer_url or not settings_row.client_id or not settings_row.client_secret_enc:
        raise ValueError("OIDC is not configured")
    return settings_row


async def _discover(issuer_url: str) -> dict:
    well_known = issuer_url.rstrip("/") + "/.well-known/openid-configuration"
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.get(well_known)
        resp.raise_for_status()
        return resp.json()


@router.get("/start")
async def start_oidc(request: Request, db: DBSession):
    await db.execute(
        delete(OIDCAuthState).where(OIDCAuthState.created_at < datetime.utcnow() - timedelta(minutes=10))
    )
    await db.commit()

    try:
        settings_row = await _load_settings(db)
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "not_found", "message": "OIDC is not configured"},
        )

    try:
        _ = decrypt_secret(settings_row.client_secret_enc or "")
    except Exception:
        return RedirectResponse("/login?error=oidc_failed", status_code=302)

    # Build redirect_uri from forwarded headers (reverse proxy aware)
    proto = request.headers.get("x-forwarded-proto", request.url.scheme)
    host = request.headers.get("x-forwarded-host", request.headers.get("host", request.url.netloc))
    redirect_uri = f"{proto}://{host}/auth/oidc/callback"

    state = secrets.token_urlsafe(32)
    code_verifier = secrets.token_urlsafe(32)
    code_challenge = _build_code_challenge(code_verifier)
    nonce = secrets.token_urlsafe(32)

    auth_state = OIDCAuthState(
        state=state,
        code_verifier=code_verifier,
        nonce=nonce,
        redirect_uri=redirect_uri,
    )
    db.add(auth_state)
    await db.commit()

    try:
        config = await _discover(settings_row.issuer_url)
    except Exception:
        return RedirectResponse("/login?error=oidc_failed", status_code=302)

    auth_url = config.get("authorization_endpoint")
    if not auth_url:
        return RedirectResponse("/login?error=oidc_failed", status_code=302)

    scopes = settings_row.scopes or "openid email profile"
    params = {
        "client_id": settings_row.client_id,
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "scope": scopes,
        "state": state,
        "nonce": nonce,
        "code_challenge": code_challenge,
        "code_challenge_method": "S256",
    }
    query = httpx.QueryParams(params)
    return RedirectResponse(f"{auth_url}?{query}", status_code=302)


@router.get("/callback")
async def oidc_callback(request: Request, db: DBSession):
    params = request.query_params
    if "error" in params or "code" not in params or "state" not in params:
        return RedirectResponse("/login?error=oidc_failed", status_code=302)

    code = params.get("code")
    state = params.get("state")
    if not code or not state:
        return RedirectResponse("/login?error=oidc_failed", status_code=302)

    result = await db.execute(select(OIDCAuthState).where(OIDCAuthState.state == state))
    auth_state = result.scalar_one_or_none()
    if auth_state is None:
        return RedirectResponse("/login?error=oidc_expired", status_code=302)
    if auth_state.used_at is not None or _is_expired(auth_state.created_at):
        return RedirectResponse("/login?error=oidc_expired", status_code=302)

    await db.execute(
        update(OIDCAuthState)
        .where(OIDCAuthState.id == auth_state.id)
        .values(used_at=datetime.utcnow())
    )
    await db.commit()

    try:
        settings_row = await _load_settings(db)
    except ValueError:
        return RedirectResponse("/login?error=oidc_failed", status_code=302)

    try:
        client_secret = decrypt_secret(settings_row.client_secret_enc or "")
    except Exception:
        return RedirectResponse("/login?error=oidc_failed", status_code=302)

    try:
        config = await _discover(settings_row.issuer_url)
    except Exception:
        return RedirectResponse("/login?error=oidc_failed", status_code=302)

    token_endpoint = config.get("token_endpoint")
    if not token_endpoint:
        return RedirectResponse("/login?error=oidc_failed", status_code=302)

    token_payload = {
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": auth_state.redirect_uri,
        "client_id": settings_row.client_id,
        "client_secret": client_secret,
        "code_verifier": auth_state.code_verifier,
    }

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            token_resp = await client.post(token_endpoint, data=token_payload)
            token_resp.raise_for_status()
            token_data = token_resp.json()
    except Exception:
        return RedirectResponse("/login?error=oidc_failed", status_code=302)

    id_token = token_data.get("id_token")
    if not id_token:
        return RedirectResponse("/login?error=oidc_failed", status_code=302)

    jwks_uri = config.get("jwks_uri")
    if not jwks_uri:
        return RedirectResponse("/login?error=oidc_failed", status_code=302)

    try:
        header = jwt.get_unverified_header(id_token)
        alg = header.get("alg")
        if not alg or alg == "none":
            return RedirectResponse("/login?error=oidc_failed", status_code=302)

        async with httpx.AsyncClient(timeout=10.0) as client:
            jwks_resp = await client.get(jwks_uri)
            jwks_resp.raise_for_status()
            jwks = jwks_resp.json()

        key = None
        if isinstance(jwks, dict):
            keys = jwks.get("keys") or []
            kid = header.get("kid")
            if kid:
                key = next((k for k in keys if k.get("kid") == kid), None)
            if key is None and keys:
                key = keys[0]

        if key is None:
            return RedirectResponse("/login?error=oidc_failed", status_code=302)

        claims = jwt.decode(
            id_token,
            key,
            algorithms=[alg],
            audience=settings_row.client_id,
            issuer=settings_row.issuer_url,
            options={"verify_at_hash": False},
        )
    except Exception:
        return RedirectResponse("/login?error=oidc_failed", status_code=302)

    if claims.get("nonce") != auth_state.nonce:
        return RedirectResponse("/login?error=oidc_failed", status_code=302)

    subject = claims.get("sub")
    email = claims.get("email")
    email_verified = bool(claims.get("email_verified"))
    if not subject:
        return RedirectResponse("/login?error=oidc_failed", status_code=302)

    result = await db.execute(
        select(OAuthIdentity).where(
            OAuthIdentity.provider == settings_row.issuer_url,
            OAuthIdentity.provider_subject == subject,
        )
    )
    identity = result.scalar_one_or_none()

    user = None
    if identity:
        result = await db.execute(select(User).where(User.id == identity.user_id))
        user = result.scalar_one_or_none()
    else:
        if not email_verified or not email:
            return RedirectResponse("/login?error=oidc_no_user", status_code=302)
        result = await db.execute(select(User).where(User.email == email))
        user = result.scalar_one_or_none()
        if user is None:
            return RedirectResponse("/login?error=oidc_no_user", status_code=302)
        identity = OAuthIdentity(
            user_id=user.id,
            provider=settings_row.issuer_url,
            provider_subject=subject,
            provider_email=email,
            provider_email_verified=email_verified,
        )
        db.add(identity)
        await db.commit()
        await db.refresh(identity)

    if user is None or not user.is_active or user.deleted_at is not None:
        return RedirectResponse("/login?error=oidc_failed", status_code=302)

    secret = generate_token_secret()
    session = UserSession(
        user_id=user.id,
        session_token_hash=await hash_password_async(secret),
        expires_at=datetime.utcnow() + timedelta(days=30),
    )
    db.add(session)
    await db.commit()
    await db.refresh(session)

    session_token = f"sess.{session.id}.{secret}"
    csrf_token = generate_token_secret()

    secure_cookie = not settings.debug
    if secure_cookie:
        is_ssl = request.url.scheme == "https" or request.headers.get("x-forwarded-proto") == "https"
        if not is_ssl:
            secure_cookie = False

    response = RedirectResponse("/", status_code=302)
    response.set_cookie(
        key="session_id",
        value=session_token,
        path="/",
        httponly=True,
        secure=secure_cookie,
        samesite="lax",
        max_age=60 * 60 * 24 * 30,
    )
    response.set_cookie(
        key="csrf_token",
        value=csrf_token,
        path="/",
        httponly=False,
        secure=secure_cookie,
        samesite="lax",
        max_age=60 * 60 * 24 * 30,
    )

    await db.execute(
        update(User).where(User.id == user.id).values(last_login_at=datetime.utcnow())
    )
    if identity is not None:
        await db.execute(
            update(OAuthIdentity)
            .where(OAuthIdentity.id == identity.id)
            .values(last_used_at=datetime.utcnow())
        )
    await db.commit()

    return response
