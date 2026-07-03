"""CSRF cookie helpers for session-authenticated browser clients."""

from __future__ import annotations

from fastapi import Request
from starlette.responses import Response

from app.core.config import settings
from app.core.security import generate_token_secret

_CSRF_MAX_AGE = 60 * 60 * 24 * 30  # 30 days, aligned with session cookie


def cookie_secure(request: Request) -> bool:
    secure = not settings.debug
    if secure:
        is_ssl = (
            request.url.scheme == "https"
            or request.headers.get("x-forwarded-proto") == "https"
        )
        if not is_ssl:
            secure = False
    return secure


def attach_csrf_cookie(request: Request, response: Response, token: str) -> None:
    response.set_cookie(
        key="csrf_token",
        value=token,
        path="/",
        httponly=False,
        secure=cookie_secure(request),
        samesite="lax",
        max_age=_CSRF_MAX_AGE,
    )


def maybe_attach_csrf_cookie(request: Request, response: Response) -> None:
    """Issue a CSRF cookie when a session user has none (legacy sessions, partial clears)."""
    principal = getattr(request.state, "principal", None)
    if not principal or principal.auth_type != "session":
        return
    if request.cookies.get("csrf_token"):
        return
    attach_csrf_cookie(request, response, generate_token_secret())
