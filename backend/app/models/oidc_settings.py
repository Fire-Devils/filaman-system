from datetime import datetime

from sqlalchemy import Boolean, DateTime, Integer, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin


class OIDCSettings(Base, TimestampMixin):
    """Single-row table storing the OIDC / OpenID Connect configuration.

    Only one row (id=1) is expected. The application upserts this row
    whenever the admin saves OIDC settings.
    """

    __tablename__ = "oidc_settings"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)

    enabled: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    # Provider configuration
    issuer_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    client_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    client_secret_enc: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Scopes to request (space-separated, e.g. "openid email profile")
    scopes: Mapped[str] = mapped_column(String(500), default="openid email profile", nullable=False)

    # Display: configurable button text on the login page
    button_text: Mapped[str] = mapped_column(String(100), default="Login with SSO", nullable=False)


class OIDCAuthState(Base):
    """Server-side OIDC auth state for PKCE flow.

    Each row represents an in-flight authorization request. Rows are
    single-use (marked via used_at) and should be cleaned up after TTL.
    """

    __tablename__ = "oidc_auth_states"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)

    # Opaque state token sent to provider and returned on callback
    state: Mapped[str] = mapped_column(String(128), nullable=False, unique=True, index=True)

    # PKCE code_verifier (plain, never sent to provider)
    code_verifier: Mapped[str] = mapped_column(String(128), nullable=False)

    # Nonce for ID token validation
    nonce: Mapped[str] = mapped_column(String(128), nullable=False)

    # Where to redirect the user after successful login
    redirect_uri: Mapped[str] = mapped_column(String(500), nullable=False)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=func.now(), nullable=False)

    # Set once the state has been consumed (one-time use)
    used_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
