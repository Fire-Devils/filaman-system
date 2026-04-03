from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, HTTPException, Request, Response, status
from pydantic import BaseModel
from sqlalchemy import select, update
from sqlalchemy.orm import selectinload

from app.api.deps import DBSession, PrincipalDep
from app.core.config import settings
from app.core.rate_limit import check_rate_limit, record_failure, record_success
from app.core.security import generate_token_secret, hash_token, verify_password_async
from app.models import AppSettings, User, UserSession

router = APIRouter(prefix="/auth", tags=["auth"])


class LoginRequest(BaseModel):
    email: str
    password: str


class LoginResponse(BaseModel):
    user_id: int
    email: str
    display_name: str | None
    language: str


class MeResponse(BaseModel):
    id: int
    email: str
    display_name: str | None
    language: str
    is_superadmin: bool
    roles: list[str]
    permissions: list[str]


@router.post("/login", response_model=LoginResponse)
async def login(
    request: Request,
    response: Response,
    data: LoginRequest,
    db: DBSession,
):
    # --- Rate limit check (runs before any DB query or password verification) ---
    check_rate_limit(request)

    settings_result = await db.execute(select(AppSettings).where(AppSettings.id == 1))
    app_settings = settings_result.scalar_one_or_none()

    if app_settings and app_settings.login_disabled:
        admin_result = await db.execute(
            select(User)
            .where(
                User.is_superadmin.is_(True),
                User.is_active.is_(True),
                User.deleted_at.is_(None),
            )
            .options(selectinload(User.roles))
            .limit(1)
        )
        user = admin_result.scalar_one_or_none()

        if user is None:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail={
                    "code": "no_admin_user",
                    "message": "No active admin user found",
                },
            )
    else:
        result = await db.execute(
            select(User)
            .where(User.email == data.email)
            .options(selectinload(User.roles))
        )
        user = result.scalar_one_or_none()

        if user is None or user.password_hash is None:
            # Record failure even for non-existent users to prevent user enumeration
            # via timing differences.
            record_failure(request)
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail={
                    "code": "invalid_credentials",
                    "message": "Invalid email or password",
                },
            )

        if not user.is_active or user.deleted_at is not None:
            record_failure(request)
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail={"code": "account_disabled", "message": "Account is disabled"},
            )

        if not await verify_password_async(data.password, user.password_hash):
            record_failure(request)
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail={
                    "code": "invalid_credentials",
                    "message": "Invalid email or password",
                },
            )

    # --- Successful authentication: reset the failure counter for this IP ---
    record_success(request)

    secret = generate_token_secret()
    session = UserSession(
        user_id=user.id,
        session_token_hash=hash_token(secret),
        expires_at=datetime.now(timezone.utc) + timedelta(days=30),
    )
    db.add(session)
    await db.commit()
    await db.refresh(session)

    session_token = f"sess.{session.id}.{secret}"
    csrf_token = generate_token_secret()

    # Determine cookie security
    # In production (debug=False), we default to Secure=True.
    # However, if the request is plainly HTTP (not HTTPS and not behind an HTTPS proxy),
    # setting Secure=True will cause the browser to drop the cookie.
    # So we relax Secure=True if we detect an insecure connection.
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
        update(User)
        .where(User.id == user.id)
        .values(last_login_at=datetime.now(timezone.utc))
    )
    await db.commit()

    return LoginResponse(
        user_id=user.id,
        email=user.email,
        display_name=user.display_name,
        language=user.language,
    )


@router.post("/logout")
async def logout(
    request: Request,
    response: Response,
    principal: PrincipalDep,
    db: DBSession,
):
    if principal.session_id:
        await db.execute(
            update(UserSession)
            .where(UserSession.id == principal.session_id)
            .values(revoked_at=datetime.now(timezone.utc))
        )
        await db.commit()

        # Evict from auth cache so the session is not reused
        from app.core.middleware import _session_cache

        _session_cache.pop(principal.session_id, None)

    response.delete_cookie("session_id", path="/")
    response.delete_cookie("csrf_token", path="/")

    return {"message": "Logged out"}


@router.get("/me", response_model=MeResponse)
async def get_me(
    principal: PrincipalDep,
    db: DBSession,
):
    from app.api.deps import resolve_user_permissions

    result = await db.execute(
        select(User)
        .where(User.id == principal.user_id)
        .options(selectinload(User.roles))
    )
    user = result.scalar_one_or_none()

    if user is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "user_not_found", "message": "User not found"},
        )

    permissions = await resolve_user_permissions(db, user.id)

    return MeResponse(
        id=user.id,
        email=user.email,
        display_name=user.display_name,
        language=user.language,
        is_superadmin=user.is_superadmin,
        roles=[r.key for r in user.roles],
        permissions=list(permissions),
    )
