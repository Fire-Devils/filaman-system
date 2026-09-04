"""RFID UID normalisation helpers.

A chip UID reaches FilaMan in several spellings: the ESP32 write flow sends
``04:EF:14:10:C8:2A:81``, the scale weigh flow sends ``04EF1410C82A81`` and
users type whatever they like.  Every comparison and every stored value goes
through :func:`normalize_rfid_uid` so those spellings all resolve to the same
spool.

Canonical form for a hex UID is upper-case byte pairs joined by ``:``
(``04:EF:14:10:C8:2A:81``).  Values that are not plain hex (legacy/test data
such as ``rfid-123``) are kept as typed, only trimmed and upper-cased, so they
still round-trip through the unique index unchanged.
"""

from __future__ import annotations

import re

_SEPARATORS = re.compile(r"[\s:\-]")
_HEX_CHARS = frozenset("0123456789ABCDEF")


def normalize_rfid_uid(uid: str | None) -> str | None:
    """Return the canonical spelling of ``uid`` or ``None`` for empty input."""
    if uid is None:
        return None
    raw = uid.strip()
    if not raw:
        return None
    compact = _SEPARATORS.sub("", raw).upper()
    if compact and len(compact) % 2 == 0 and set(compact) <= _HEX_CHARS:
        return ":".join(compact[i : i + 2] for i in range(0, len(compact), 2))
    return raw.upper()


def rfid_match_values(uid: str) -> list[str]:
    """Upper-cased spellings a stored column value may have for ``uid``.

    Stored values are canonical after the ``rfid_uid_2`` migration, but rows
    written directly (tests, legacy data the migration could not rewrite) may
    still hold the raw spelling.  Callers compare ``upper(column) IN (...)``.
    """
    raw_upper = uid.strip().upper()
    canonical = normalize_rfid_uid(uid)
    values = [raw_upper]
    if canonical and canonical != raw_upper:
        values.append(canonical)
    return values


def rfid_uids_equal(a: str | None, b: str | None) -> bool:
    """True when ``a`` and ``b`` denote the same chip in any spelling."""
    if not a or not b:
        return False
    return bool(set(rfid_match_values(a)) & set(rfid_match_values(b)))
