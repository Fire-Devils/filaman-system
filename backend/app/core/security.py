import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any

from passlib.context import CryptContext

pwd_context = CryptContext(schemes=["argon2"], deprecated="auto")


def hash_password(password: str) -> str:
    return pwd_context.hash(password)


def verify_password(plain_password: str, hashed_password: str) -> bool:
    return pwd_context.verify(plain_password, hashed_password)


def generate_token_secret() -> str:
    return secrets.token_urlsafe(32)


def parse_token(token: str) -> tuple[str, int, str] | None:
    parts = token.split(".")
    if len(parts) != 3:
        return None
    prefix, id_str, secret = parts
    if prefix not in ("sess", "uak", "dev"):
        return None
    try:
        token_id = int(id_str)
    except ValueError:
        return None
    return prefix, token_id, secret


@dataclass
class Principal:
    auth_type: str
    user_id: int | None = None
    device_id: int | None = None
    api_key_id: int | None = None
    session_id: int | None = None
    is_superadmin: bool = False
    scopes: list[str] | None = None
    user_email: str | None = None
    user_display_name: str | None = None
    user_language: str = "en"
