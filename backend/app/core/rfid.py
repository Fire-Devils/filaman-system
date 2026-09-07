"""RFID UID comparison and storage helpers.

A chip UID reaches FilaMan in several spellings: the ESP32 write flow sends
``04:EF:14:10:C8:2A:81``, the scale weigh flow sends ``04EF1410C82A81`` and
users type whatever they like. Comparisons use :func:`normalize_rfid_uid` so
those spellings all resolve to the same spool, while storage preserves the
submitted spelling for clients that read the field back.

The comparison form for a hex UID is upper-case byte pairs joined by ``:``
(``04:EF:14:10:C8:2A:81``). Values that are not plain hex (legacy/test data
such as ``rfid-123``) compare case-insensitively without removing punctuation.
"""

from __future__ import annotations

import re

_SEPARATORS = re.compile(r"[\s:\-]")
_HEX_CHARS = frozenset("0123456789ABCDEF")


def normalize_rfid_uid(uid: str | None) -> str | None:
    """Return a canonical comparison value or ``None`` for empty input."""
    if uid is None:
        return None
    raw = uid.strip()
    if not raw:
        return None
    compact = _SEPARATORS.sub("", raw).upper()
    if compact and len(compact) % 2 == 0 and set(compact) <= _HEX_CHARS:
        return ":".join(compact[i : i + 2] for i in range(0, len(compact), 2))
    return raw.upper()


def rfid_hex_key(uid: str | None) -> str | None:
    """Return separator-free upper-case hex, or ``None`` for a non-hex value."""
    if uid is None:
        return None
    compact = _SEPARATORS.sub("", uid.strip()).upper()
    if compact and len(compact) % 2 == 0 and set(compact) <= _HEX_CHARS:
        return compact
    return None


def rfid_storage_value(uid: str | None) -> str | None:
    """Preserve a submitted UID's spelling, trimming only outer whitespace."""
    if uid is None:
        return None
    value = uid.strip()
    return value or None


def rfid_uids_equal(a: str | None, b: str | None) -> bool:
    """True when ``a`` and ``b`` denote the same chip in any spelling."""
    if not a or not b:
        return False
    return normalize_rfid_uid(a) == normalize_rfid_uid(b)
