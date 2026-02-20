from datetime import datetime
from typing import Callable
import uuid

from fastapi import Request, Response
from starlette.middleware.base import BaseHTTPMiddleware
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import async_session_maker
from app.core.security import parse_token, pwd_context, Principal, verify_password_async
from app.core.logging_config import set_request_id


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
            path.startswith("/_astro/") or
            path.startswith("/img/") or
            path.startswith("/health") or
            path in ("/favicon.png", "/logo.png", "/icons.svg") or
            path.endswith((".js", ".css", ".png", ".jpg", ".svg", ".woff2", ".ico"))
        ):
            return await call_next(request)

        session_token = request.cookies.get("session_id")
        if session_token:
            principal = await self._authenticate_session(session_token)
            if principal:
                request.state.principal = principal
                return await call_next(request)

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
            if session.expires_at and session.expires_at < datetime.utcnow():
                return None
            if not await verify_password_async(secret, session.session_token_hash):
                return None

            result = await db.execute(select(User).where(User.id == session.user_id))
            user = result.scalar_one_or_none()

            if user is None or not user.is_active or user.deleted_at is not None:
                return None

            await db.execute(
                update(UserSession)
                .where(UserSession.id == session_id)
                .values(last_used_at=datetime.utcnow())
            )
            await db.commit()

            return Principal(
                auth_type="session",
                user_id=user.id,
                session_id=session_id,
                is_superadmin=user.is_superadmin,
                user_email=user.email,
                user_display_name=user.display_name,
                user_language=user.language,
            )

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
            if not await verify_password_async(secret, api_key.key_hash):
                return None

            result = await db.execute(select(User).where(User.id == api_key.user_id))
            user = result.scalar_one_or_none()

            if user is None or not user.is_active or user.deleted_at is not None:
                return None

            await db.execute(
                update(UserApiKey)
                .where(UserApiKey.id == key_id)
                .values(last_used_at=datetime.utcnow())
            )
            await db.commit()

            return Principal(
                auth_type="api_key",
                user_id=user.id,
                api_key_id=key_id,
                is_superadmin=user.is_superadmin,
                scopes=api_key.scopes,
                user_email=user.email,
                user_display_name=user.display_name,
                user_language=user.language,
            )

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
            if not await verify_password_async(secret, device.token_hash):
                return None

            await db.execute(
                update(Device)
                .where(Device.id == device_id)
                .values(last_used_at=datetime.utcnow())
            )
            await db.commit()

            return Principal(
                auth_type="device",
                device_id=device_id,
                scopes=device.scopes,
            )


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
                            content={"code": "csrf_failed", "message": "CSRF token mismatch"},
                        )

        return await call_next(request)
