import logging

from cryptography.fernet import Fernet, InvalidToken

from app.core.config import settings

logger = logging.getLogger(__name__)


def _get_fernet() -> Fernet:
    key = settings.oidc_enc_key
    if not key:
        raise RuntimeError(
            "OIDC_ENC_KEY is not configured. "
            "Generate one with: python -c \"from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())\""
        )
    try:
        return Fernet(key.encode() if isinstance(key, str) else key)
    except Exception:
        raise RuntimeError("OIDC_ENC_KEY is not a valid Fernet key.")


def encrypt_secret(plaintext: str) -> str:
    f = _get_fernet()
    return f.encrypt(plaintext.encode()).decode()


def decrypt_secret(ciphertext: str) -> str:
    f = _get_fernet()
    try:
        return f.decrypt(ciphertext.encode()).decode()
    except InvalidToken:
        logger.error("Failed to decrypt OIDC secret — key may have changed")
        raise RuntimeError("Failed to decrypt OIDC secret")
