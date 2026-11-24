import asyncio
import hashlib
import hmac
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


async def hash_password_async(password: str) -> str:
    return await asyncio.to_thread(pwd_context.hash, password)


async def verify_password_async(plain_password: str, hashed_password: str) -> bool:
    return await asyncio.to_thread(pwd_context.verify, plain_password, hashed_password)


def generate_token_secret() -> str:
    return secrets.token_urlsafe(32)


def hash_token(secret: str) -> str:
    """Hash a high-entropy token using SHA-256. Fast and secure for random tokens (not passwords)."""
    return hashlib.sha256(secret.encode()).hexdigest()


def verify_token(secret: str, token_hash: str) -> bool:
    """Verify a token against its SHA-256 hash using constant-time comparison."""
    computed = hashlib.sha256(secret.encode()).hexdigest()
    return hmac.compare_digest(computed, token_hash)


def is_argon2_hash(h: str) -> bool:
    """Check if a hash string is an argon2 hash (starts with $argon2)."""
    return h.startswith('$argon2')

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
    needs_cookie_extension: bool = False


def generate_device_code() -> str:
    """Generate a 6-character alphanumeric code for device registration."""
    alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    return "".join(secrets.choice(alphabet) for _ in range(6))


def normalize_email(value: str) -> str:
    """Normalize an e-mail address for storage and case-insensitive lookup."""
    return value.strip().lower()
