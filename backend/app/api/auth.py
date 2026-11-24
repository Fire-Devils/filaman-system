from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, HTTPException, Request, Response, status
from pydantic import BaseModel
from sqlalchemy import func, select, update
from sqlalchemy.orm import selectinload

from app.api.deps import DBSession, PrincipalDep
from app.core.config import settings
from app.core.security import (
    generate_token_secret,
    hash_password,
    hash_token,
    normalize_email,
    verify_password_async,
)
from app.models import AppSettings, User, UserSession

router = APIRouter(prefix="/auth", tags=["auth"])

# Brute-force protection settings
MAX_LOGIN_ATTEMPTS = 5
LOCKOUT_DURATION_MINUTES = 15

# Dummy hash for timing-safe comparison when user doesn't exist
# This prevents user enumeration via timing attacks
_DUMMY_HASH = hash_password("dummy-password-for-timing")


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
            .where(func.lower(User.email) == normalize_email(data.email))
            .options(selectinload(User.roles))
        )
        candidates = list(result.scalars().all())
        user = None
        if len(candidates) == 1:
            user = candidates[0]
        elif candidates:
            # Legacy data: several users whose emails differ only by case.
            user = next((u for u in candidates if u.email == data.email.strip()), None)
            if user is None:
                for cand in candidates:
                    if cand.password_hash and await verify_password_async(
                        data.password, cand.password_hash
                    ):
                        user = cand
                        break

        if user is None or user.password_hash is None:
            # Perform dummy password check to prevent timing-based user enumeration
            # This ensures response time is consistent regardless of user existence
            await verify_password_async(data.password, _DUMMY_HASH)
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail={
                    "code": "invalid_credentials",
                    "message": "Invalid email or password",
                },
            )

        if not user.is_active or user.deleted_at is not None:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail={"code": "account_disabled", "message": "Account is disabled"},
            )

        # Check if account is locked due to too many failed attempts
        now = datetime.now(timezone.utc)
        if user.locked_until and user.locked_until > now:
            remaining_seconds = int((user.locked_until - now).total_seconds())
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail={
                    "code": "account_locked",
                    "message": f"Account temporarily locked. Try again in {remaining_seconds} seconds.",
                    "retry_after": remaining_seconds,
                },
            )

        if not await verify_password_async(data.password, user.password_hash):
            # Increment failed login counter
            user.failed_login_count = (user.failed_login_count or 0) + 1

            if user.failed_login_count >= MAX_LOGIN_ATTEMPTS:
                # Lock the account
                user.locked_until = now + timedelta(minutes=LOCKOUT_DURATION_MINUTES)
                user.failed_login_count = 0  # Reset counter after locking
                await db.commit()
                raise HTTPException(
                    status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                    detail={
                        "code": "account_locked",
                        "message": f"Too many failed attempts. Account locked for {LOCKOUT_DURATION_MINUTES} minutes.",
                        "retry_after": LOCKOUT_DURATION_MINUTES * 60,
                    },
                )

            await db.commit()
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail={
                    "code": "invalid_credentials",
                    "message": "Invalid email or password",
                },
            )

        # Successful login: reset failed login counter and clear any lock
        if user.failed_login_count > 0 or user.locked_until:
            user.failed_login_count = 0
            user.locked_until = None

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
