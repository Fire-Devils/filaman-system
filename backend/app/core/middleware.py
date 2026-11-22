import logging
import time
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

from fastapi import Request, Response
from sqlalchemy import select, update
from starlette.middleware.base import BaseHTTPMiddleware

from app.core.config import settings
from app.core.database import async_session_maker
from app.core.logging_config import set_request_id
from app.core.security import (
    Principal,
    hash_token,
    is_argon2_hash,
    parse_token,
    verify_password_async,
    verify_token,
)

logger = logging.getLogger(__name__)

# Credential and account state are read from the database on every request.
_LAST_USED_THROTTLE = 300
_last_used_writes: dict[str, float] = {}


def invalidate_auth_caches() -> None:
    """Reset usage-write throttles; authorization itself is never cached."""
    _last_used_writes.clear()


def _should_write_last_used(cache_key: str) -> bool:
    """Return True if enough time has passed to justify a DB write."""
    now = time.monotonic()
    last_write = _last_used_writes.get(cache_key, 0)
    if now - last_write >= _LAST_USED_THROTTLE:
        _last_used_writes[cache_key] = now
        return True
    return False


class RequestIdMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next: Callable) -> Response:
        request_id = request.headers.get("X-Request-Id") or str(uuid.uuid4())
        set_request_id(request_id)
        response = await call_next(request)
        response.headers["X-Request-Id"] = request_id
        set_request_id(None)
        return response


class AuthMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next: Callable) -> Response:
        request.state.principal = None

        # Optimization: Skip auth for static files and health checks
        path = request.url.path
        is_api = path.startswith("/api/") or path.startswith("/auth/")
        if not is_api and (
            path.startswith("/_astro/")
            or path.startswith("/img/")
            or path.startswith("/health")
            or path in ("/favicon.png", "/logo.png", "/icons.svg")
            or path.endswith((".js", ".css", ".png", ".jpg", ".svg", ".woff2", ".ico"))
        ):
            return await call_next(request)

        auth_header = request.headers.get("Authorization", "")
        if auth_header.startswith("Device "):
            token = auth_header[7:]
            principal = await self._authenticate_device(token)
            if principal:
                request.state.principal = principal
                return await call_next(request)

        session_token = request.cookies.get("session_id")
        if session_token:
            principal = await self._authenticate_session(session_token)
            if principal:
                request.state.principal = principal
                response = await call_next(request)

                # Check if session needs extension and update the cookie
                from app.core.csrf import attach_csrf_cookie, maybe_attach_csrf_cookie

                maybe_attach_csrf_cookie(request, response)

                if getattr(principal, "needs_cookie_extension", False):
                    secure_cookie = not settings.debug
                    if secure_cookie:
                        is_ssl = (
                            request.url.scheme == "https"
                            or request.headers.get("x-forwarded-proto") == "https"
                        )
                        if not is_ssl:
                            secure_cookie = False

                    response.set_cookie(
                        key="session_id",
                        value=session_token,
                        path="/",
                        httponly=True,
                        secure=secure_cookie,
                        samesite="lax",
                        max_age=60 * 60 * 24 * 30,  # Extend by 30 days
                    )

                    # Keep the CSRF cookie's lifetime in lock-step with the
                    # rolling session cookie. Otherwise the CSRF cookie expires
                    # 30 days after login while the session keeps rolling,
                    # leaving a valid session with no CSRF cookie -> spurious
                    # "csrf_failed" on the next write request until re-login.
                    # Reuse the existing token value so in-flight requests
                    # carrying the old value keep validating.
                    existing_csrf = request.cookies.get("csrf_token")
                    if existing_csrf:
                        attach_csrf_cookie(request, response, existing_csrf)
                return response

        if auth_header.startswith("ApiKey "):
            token = auth_header[7:]
            principal = await self._authenticate_api_key(token)
            if principal:
                request.state.principal = principal
                return await call_next(request)

        return await call_next(request)

    async def _authenticate_session(self, token: str) -> Principal | None:
        parsed = parse_token(token)
        if parsed is None or parsed[0] != "sess":
            return None

        _, session_id, secret = parsed

        async with async_session_maker() as db:
            from app.models import User, UserSession

            result = await db.execute(
                select(UserSession).where(UserSession.id == session_id)
            )
            session = result.scalar_one_or_none()

            if session is None:
                return None
            if session.revoked_at is not None:
                return None
            if session.expires_at and session.expires_at < datetime.now(timezone.utc):
                return None
            needs_commit = False
            if is_argon2_hash(session.session_token_hash):
                # Legacy argon2 hash — verify and migrate to SHA-256
                if not await verify_password_async(secret, session.session_token_hash):
                    return None
                # Migrate: replace argon2 hash with fast SHA-256 hash
                new_hash = hash_token(secret)
                session.session_token_hash = new_hash
                needs_commit = True
                await db.execute(
                    update(UserSession)
                    .where(UserSession.id == session_id)
                    .values(session_token_hash=new_hash)
                )
            else:
                # Fast SHA-256 verification (microseconds, not 100-500ms)
                if not verify_token(secret, session.session_token_hash):
                    return None

            result = await db.execute(select(User).where(User.id == session.user_id))
            user = result.scalar_one_or_none()

            if user is None or not user.is_active or user.deleted_at is not None:
                return None

            now = datetime.now(timezone.utc)
            update_values_db: dict[str, Any] = {}
            if _should_write_last_used(f"sess:{session_id}"):
                update_values_db["last_used_at"] = now

            # Rolling session: If session expires in less than 15 days, extend it by another 30 days
            needs_extension = False
            if session.expires_at and (session.expires_at - now).days < 15:
                update_values_db["expires_at"] = now + timedelta(days=30)
                needs_extension = True

            if update_values_db:
                await db.execute(
                    update(UserSession)
                    .where(UserSession.id == session_id)
                    .values(**update_values_db)
                )
                needs_commit = True
            if needs_commit:
                await db.commit()

            principal = Principal(
                auth_type="session",
                user_id=user.id,
                session_id=session_id,
                is_superadmin=user.is_superadmin,
                user_email=user.email,
                user_display_name=user.display_name,
                user_language=user.language,
            )

            # Attach a flag so we can update the cookie in the response
            if needs_extension:
                principal.needs_cookie_extension = True

            return principal

    async def _authenticate_api_key(self, token: str) -> Principal | None:
        parsed = parse_token(token)
        if parsed is None or parsed[0] != "uak":
            return None

        _, key_id, secret = parsed

        async with async_session_maker() as db:
            from app.models import User, UserApiKey

            result = await db.execute(select(UserApiKey).where(UserApiKey.id == key_id))
            api_key = result.scalar_one_or_none()

            if api_key is None:
                return None
            needs_commit = False
            if is_argon2_hash(api_key.key_hash):
                # Legacy argon2 hash — verify and migrate to SHA-256
                if not await verify_password_async(secret, api_key.key_hash):
                    return None
                new_hash = hash_token(secret)
                await db.execute(
                    update(UserApiKey)
                    .where(UserApiKey.id == key_id)
                    .values(key_hash=new_hash)
                )
                api_key.key_hash = new_hash
                needs_commit = True
            else:
                if not verify_token(secret, api_key.key_hash):
                    return None

            result = await db.execute(select(User).where(User.id == api_key.user_id))
            user = result.scalar_one_or_none()

            if user is None or not user.is_active or user.deleted_at is not None:
                return None

            if _should_write_last_used(f"uak:{key_id}"):
                await db.execute(
                    update(UserApiKey)
                    .where(UserApiKey.id == key_id)
                    .values(last_used_at=datetime.now(timezone.utc))
                )
                needs_commit = True
            if needs_commit:
                await db.commit()

            principal = Principal(
                auth_type="api_key",
                user_id=user.id,
                api_key_id=key_id,
                is_superadmin=user.is_superadmin,
                scopes=api_key.scopes,
                user_email=user.email,
                user_display_name=user.display_name,
                user_language=user.language,
            )

            return principal

    async def _authenticate_device(self, token: str) -> Principal | None:
        parsed = parse_token(token)
        if parsed is None or parsed[0] != "dev":
            return None

        _, device_id, secret = parsed

        async with async_session_maker() as db:
            from app.models import Device

            result = await db.execute(select(Device).where(Device.id == device_id))
            device = result.scalar_one_or_none()

            if device is None:
                return None
            if not device.is_active or device.deleted_at is not None:
                return None
            needs_commit = False
            if is_argon2_hash(device.token_hash):
                # Legacy argon2 hash — verify and migrate to SHA-256
                legacy_hash = device.token_hash
                if not await verify_password_async(secret, legacy_hash):
                    return None
                new_hash = hash_token(secret)
                migration = await db.execute(
                    update(Device)
                    .where(
                        Device.id == device_id,
                        Device.token_hash == legacy_hash,
                    )
                    .values(token_hash=new_hash)
                )
                if migration.rowcount != 1:
                    await db.rollback()
                    result = await db.execute(
                        select(Device).where(Device.id == device_id)
                    )
                    device = result.scalar_one_or_none()
                    if (
                        device is None
                        or not device.is_active
                        or device.deleted_at is not None
                        or not verify_token(secret, device.token_hash)
                    ):
                        return None
                else:
                    device.token_hash = new_hash
                    needs_commit = True
            else:
                if not verify_token(secret, device.token_hash):
                    return None

            if _should_write_last_used(f"dev:{device_id}"):
                await db.execute(
                    update(Device)
                    .where(Device.id == device_id)
                    .values(last_used_at=datetime.now(timezone.utc))
                )
                needs_commit = True

            if needs_commit:
                await db.commit()

            principal = Principal(
                auth_type="device",
                device_id=device_id,
                scopes=device.scopes,
            )
            return principal


class CsrfMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next: Callable) -> Response:
        if request.method in ("POST", "PUT", "PATCH", "DELETE"):
            path = request.url.path
            if path.startswith("/api/v1/") or path == "/auth/logout":
                principal = getattr(request.state, "principal", None)
                if principal and principal.auth_type == "session":
                    csrf_cookie = request.cookies.get("csrf_token")
                    csrf_header = request.headers.get("X-CSRF-Token")

                    if not csrf_cookie or not csrf_header or csrf_cookie != csrf_header:
                        from fastapi.responses import JSONResponse

                        return JSONResponse(
                            status_code=403,
                            content={
                                "code": "csrf_failed",
                                "message": "CSRF token mismatch",
                            },
                        )

        return await call_next(request)
