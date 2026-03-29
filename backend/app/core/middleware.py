import asyncio
from datetime import datetime, timedelta, timezone
from typing import Any, Callable
import logging
import time
import uuid

from fastapi import Request, Response
from starlette.middleware.base import BaseHTTPMiddleware
from sqlalchemy import select, update

from app.core.database import async_session_maker
from app.core.security import (
    parse_token,
    pwd_context,
    Principal,
    verify_password_async,
    verify_token,
    is_argon2_hash,
    hash_token,
)
from app.core.logging_config import set_request_id
from app.core.config import settings

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# In-memory auth cache: avoids 2 SELECTs + 1 UPDATE per request
# ---------------------------------------------------------------------------
_SESSION_CACHE_TTL = 60  # seconds – cached Principal lives this long
_LAST_USED_THROTTLE = 300  # seconds – only write last_used_at every 5 min
_API_KEY_CACHE_TTL = 60
_DEVICE_CACHE_TTL = 60

# {session_id: (Principal, token_hash, user_active, expires_at, cached_at)}
_session_cache: dict[int, tuple[Principal, str, bool, datetime | None, float]] = {}
# {api_key_id: (Principal, key_hash, user_active, cached_at)}
_api_key_cache: dict[int, tuple[Principal, str, bool, float]] = {}
# {device_id: (Principal, token_hash, device_active, cached_at)}
_device_cache: dict[int, tuple[Principal, str, bool, float]] = {}
# Track last_used_at write timestamps to throttle DB writes
_last_used_writes: dict[str, float] = {}  # "sess:123" -> monotonic timestamp


def invalidate_auth_caches() -> None:
    """Clear all auth caches. Call after user/session/key changes."""
    _session_cache.clear()
    _api_key_cache.clear()
    _device_cache.clear()
    _last_used_writes.clear()


def _should_write_last_used(cache_key: str) -> bool:
    """Return True if enough time has passed to justify a DB write."""
    now = time.monotonic()
    last_write = _last_used_writes.get(cache_key, 0)
    if now - last_write >= _LAST_USED_THROTTLE:
        _last_used_writes[cache_key] = now
        return True
    return False


async def _bg_write_last_used(
    model_class: type,
    pk_column: str,
    pk_value: int,
    extra_values: dict[str, Any] | None = None,
) -> None:
    """Fire-and-forget background task to update last_used_at.

    Runs in its own DB session so it never interferes with the
    request-handler's session (avoids SQLAlchemy concurrent-state errors
    with BaseHTTPMiddleware).
    """
    try:
        async with async_session_maker() as db:
            values: dict[str, Any] = {"last_used_at": datetime.now(timezone.utc)}
            if extra_values:
                values.update(extra_values)
            await db.execute(
                update(model_class)
                .where(getattr(model_class, pk_column) == pk_value)
                .values(**values)
            )
            await db.commit()
    except Exception:
        logger.debug("Background last_used_at write failed", exc_info=True)


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

        session_token = request.cookies.get("session_id")
        if session_token:
            principal = await self._authenticate_session(session_token)
            if principal:
                request.state.principal = principal
                response = await call_next(request)

                # Check if session needs extension and update the cookie
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
                return response

        auth_header = request.headers.get("Authorization", "")
        if auth_header.startswith("ApiKey "):
            token = auth_header[7:]
            principal = await self._authenticate_api_key(token)
            if principal:
                request.state.principal = principal
                return await call_next(request)

        if auth_header.startswith("Device "):
            token = auth_header[7:]
            principal = await self._authenticate_device(token)
            if principal:
                request.state.principal = principal
                return await call_next(request)

        return await call_next(request)

    async def _authenticate_session(self, token: str) -> Principal | None:
        parsed = parse_token(token)
        if parsed is None or parsed[0] != "sess":
            return None

        _, session_id, secret = parsed

        # --- Fast path: check in-memory cache first ---
        cached = _session_cache.get(session_id)
        if cached is not None:
            principal, cached_hash, user_active, expires_at, cached_at = cached
            now_mono = time.monotonic()
            if now_mono - cached_at < _SESSION_CACHE_TTL:
                # Verify token against cached hash (constant-time, microseconds)
                if not verify_token(secret, cached_hash):
                    return None
                if not user_active:
                    return None
                if expires_at and expires_at < datetime.now(timezone.utc):
                    _session_cache.pop(session_id, None)
                    return None

                # Throttled last_used_at write
                now = datetime.now(timezone.utc)
                needs_extension = False
                if expires_at and (expires_at - now).days < 15:
                    needs_extension = True

                cache_key = f"sess:{session_id}"
                if _should_write_last_used(cache_key) or needs_extension:
                    from app.models import UserSession

                    extra: dict[str, Any] | None = None
                    if needs_extension:
                        new_expires = now + timedelta(days=30)
                        extra = {"expires_at": new_expires}
                        # Update cached expires_at
                        _session_cache[session_id] = (
                            principal,
                            cached_hash,
                            user_active,
                            new_expires,
                            cached_at,
                        )
                    asyncio.create_task(
                        _bg_write_last_used(UserSession, "id", session_id, extra)
                    )

                if needs_extension:
                    principal.needs_cookie_extension = True
                else:
                    principal.needs_cookie_extension = False
                return principal
            else:
                # Cache expired, remove entry
                _session_cache.pop(session_id, None)

        # --- Slow path: full DB lookup ---
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
            if is_argon2_hash(session.session_token_hash):
                # Legacy argon2 hash — verify and migrate to SHA-256
                if not await verify_password_async(secret, session.session_token_hash):
                    return None
                # Migrate: replace argon2 hash with fast SHA-256 hash
                new_hash = hash_token(secret)
                session.session_token_hash = new_hash
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
            update_values_db: dict[str, Any] = {"last_used_at": now}

            # Rolling session: If session expires in less than 15 days, extend it by another 30 days
            needs_extension = False
            if session.expires_at and (session.expires_at - now).days < 15:
                update_values_db["expires_at"] = now + timedelta(days=30)
                needs_extension = True

            await db.execute(
                update(UserSession)
                .where(UserSession.id == session_id)
                .values(**update_values_db)
            )
            await db.commit()

            # Record the last_used write
            _last_used_writes[f"sess:{session_id}"] = time.monotonic()

            principal = Principal(
                auth_type="session",
                user_id=user.id,
                session_id=session_id,
                is_superadmin=user.is_superadmin,
                user_email=user.email,
                user_display_name=user.display_name,
                user_language=user.language,
            )

            # Populate cache
            effective_expires = update_values_db.get("expires_at", session.expires_at)
            _session_cache[session_id] = (
                principal,
                session.session_token_hash,
                True,  # user_active
                effective_expires,
                time.monotonic(),
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

        # --- Fast path: check in-memory cache ---
        cached = _api_key_cache.get(key_id)
        if cached is not None:
            principal, cached_hash, user_active, cached_at = cached
            if time.monotonic() - cached_at < _API_KEY_CACHE_TTL:
                if not verify_token(secret, cached_hash):
                    return None
                if not user_active:
                    return None
                # Throttled last_used_at write
                cache_key = f"uak:{key_id}"
                if _should_write_last_used(cache_key):
                    from app.models import UserApiKey

                    asyncio.create_task(_bg_write_last_used(UserApiKey, "id", key_id))
                return principal
            else:
                _api_key_cache.pop(key_id, None)

        # --- Slow path: full DB lookup ---
        async with async_session_maker() as db:
            from app.models import User, UserApiKey

            result = await db.execute(select(UserApiKey).where(UserApiKey.id == key_id))
            api_key = result.scalar_one_or_none()

            if api_key is None:
                return None
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
            else:
                if not verify_token(secret, api_key.key_hash):
                    return None

            result = await db.execute(select(User).where(User.id == api_key.user_id))
            user = result.scalar_one_or_none()

            if user is None or not user.is_active or user.deleted_at is not None:
                return None

            await db.execute(
                update(UserApiKey)
                .where(UserApiKey.id == key_id)
                .values(last_used_at=datetime.now(timezone.utc))
            )
            await db.commit()

            _last_used_writes[f"uak:{key_id}"] = time.monotonic()

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

            # Populate cache
            _api_key_cache[key_id] = (
                principal,
                api_key.key_hash,
                True,
                time.monotonic(),
            )

            return principal

    async def _authenticate_device(self, token: str) -> Principal | None:
        parsed = parse_token(token)
        if parsed is None or parsed[0] != "dev":
            return None

        _, device_id, secret = parsed

        # --- Fast path: check in-memory cache ---
        cached = _device_cache.get(device_id)
        if cached is not None:
            principal, cached_hash, device_active, cached_at = cached
            if time.monotonic() - cached_at < _DEVICE_CACHE_TTL:
                if not verify_token(secret, cached_hash):
                    return None
                if not device_active:
                    return None
                # Throttled last_used_at write
                cache_key = f"dev:{device_id}"
                if _should_write_last_used(cache_key):
                    from app.models import Device

                    asyncio.create_task(_bg_write_last_used(Device, "id", device_id))
                return principal
            else:
                _device_cache.pop(device_id, None)

        # --- Slow path: full DB lookup ---
        async with async_session_maker() as db:
            from app.models import Device

            result = await db.execute(select(Device).where(Device.id == device_id))
            device = result.scalar_one_or_none()

            if device is None:
                return None
            if not device.is_active or device.deleted_at is not None:
                return None
            if is_argon2_hash(device.token_hash):
                # Legacy argon2 hash — verify and migrate to SHA-256
                if not await verify_password_async(secret, device.token_hash):
                    return None
                new_hash = hash_token(secret)
                await db.execute(
                    update(Device)
                    .where(Device.id == device_id)
                    .values(token_hash=new_hash)
                )
                device.token_hash = new_hash
            else:
                if not verify_token(secret, device.token_hash):
                    return None

            await db.execute(
                update(Device)
                .where(Device.id == device_id)
                .values(last_used_at=datetime.now(timezone.utc))
            )
            await db.commit()

            _last_used_writes[f"dev:{device_id}"] = time.monotonic()

            principal = Principal(
                auth_type="device",
                device_id=device_id,
                scopes=device.scopes,
            )

            # Populate cache
            _device_cache[device_id] = (
                principal,
                device.token_hash,
                True,
                time.monotonic(),
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
