"""Lightweight in-memory cache with TTL for rarely-changing API data.

Usage:
    from app.core.cache import response_cache

    # Read (returns None on miss)
    data = response_cache.get("app_settings_public")

    # Write
    response_cache.set("app_settings_public", payload, ttl=300)

    # Invalidate after mutation
    response_cache.delete("app_settings_public")

    # Invalidate everything (e.g. after plugin install)
    response_cache.clear()
"""

from __future__ import annotations

import time
from typing import Any


class TTLCache:
    """Thread-safe (GIL-protected) dict cache with per-key TTL."""

    def __init__(self) -> None:
        self._store: dict[str, tuple[Any, float]] = {}

    def get(self, key: str) -> Any | None:
        entry = self._store.get(key)
        if entry is None:
            return None
        value, expires_at = entry
        if time.monotonic() > expires_at:
            self._store.pop(key, None)
            return None
        return value

    def set(self, key: str, value: Any, ttl: int = 300) -> None:
        """Store *value* under *key* for *ttl* seconds (default 5 min)."""
        self._store[key] = (value, time.monotonic() + ttl)

    def delete(self, key: str) -> None:
        self._store.pop(key, None)

    def clear(self) -> None:
        self._store.clear()

    def purge_expired(self) -> int:
        """Remove all expired entries and return how many were purged."""
        now = time.monotonic()
        expired = [k for k, (_, exp) in self._store.items() if now > exp]
        for k in expired:
            del self._store[k]
        return len(expired)


# Singleton – import this everywhere
response_cache = TTLCache()
