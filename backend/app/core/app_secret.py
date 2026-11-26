"""Eigener Fernet-Schlüssel für in der App gespeicherte Geheimnisse.

Nicht zu verwechseln mit ``OIDC_ENC_KEY`` (OIDC-Client-Secret). Quelle des
Schlüssels:

1. Umgebungsvariable ``FILAMAN_ENC_KEY`` (beliebiger String, wird per SHA-256
   zu einem Fernet-Schlüssel abgeleitet), sonst
2. Datei ``DATA_DIR/.filaman_enc.key``. Sie wird beim ersten Bedarf zufällig
   erzeugt (Modus 0600, atomar, sicher bei mehreren Workern).
"""

import base64
import hashlib
import logging
import os
import tempfile
from pathlib import Path

from cryptography.fernet import Fernet, InvalidToken

from app.core.config import DATA_DIR

logger = logging.getLogger(__name__)

ENV_NAME = "FILAMAN_ENC_KEY"
KEY_FILE_NAME = ".filaman_enc.key"


class AppSecretError(Exception):
    """Ein gespeichertes Geheimnis lässt sich nicht entschlüsseln (Schlüssel gewechselt)."""


def _key_file() -> Path:
    return DATA_DIR / KEY_FILE_NAME


def _create_key_file(path: Path) -> None:
    """Schlüsseldatei atomar anlegen; existiert sie schon, bleibt sie unberührt."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(dir=path.parent, prefix=".filaman_enc.tmp")
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(Fernet.generate_key())
        os.chmod(tmp_name, 0o600)
        try:
            # link() schlägt fehl, wenn ein anderer Worker schneller war.
            os.link(tmp_name, path)
        except FileExistsError:
            pass
    finally:
        try:
            os.unlink(tmp_name)
        except FileNotFoundError:
            pass


def _get_fernet() -> Fernet:
    raw = os.environ.get(ENV_NAME, "").strip()
    if raw:
        digest = hashlib.sha256(raw.encode()).digest()
        return Fernet(base64.urlsafe_b64encode(digest))
    path = _key_file()
    if not path.is_file():
        _create_key_file(path)
    try:
        return Fernet(path.read_bytes().strip())
    except ValueError as exc:
        raise AppSecretError(f"{KEY_FILE_NAME} is not a valid key") from exc


def encrypt_app_secret(plaintext: str) -> str:
    return _get_fernet().encrypt(plaintext.encode()).decode()


def decrypt_app_secret(ciphertext: str) -> str:
    try:
        return _get_fernet().decrypt(ciphertext.encode()).decode()
    except InvalidToken as exc:
        logger.error("Stored secret cannot be decrypted - encryption key changed?")
        raise AppSecretError("Stored secret cannot be decrypted") from exc
