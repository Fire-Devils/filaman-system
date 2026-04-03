"""
Login rate limiter – in-memory sliding window per client IP.

Design goals:
  - No additional dependencies (consistent with the existing auth cache in middleware.py).
  - Tracks *failed* login attempts only; a successful login resets the counter.
  - Configurable via environment variables so operators can tune or disable.
  - Thread-safe for use inside asyncio (GIL + no await between read/write).

Environment variables (all optional):
  LOGIN_RATE_LIMIT_ENABLED          bool   true
  LOGIN_RATE_LIMIT_MAX_ATTEMPTS     int    10   failed attempts before lockout
  LOGIN_RATE_LIMIT_WINDOW_SECONDS   int    300  sliding window length (5 min)
  LOGIN_RATE_LIMIT_LOCKOUT_SECONDS  int    300  lockout duration (5 min)
"""

import time
import logging
from collections import deque

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# In-memory store: {ip: deque of failure timestamps (monotonic)}
# ---------------------------------------------------------------------------
_failure_store: dict[str, deque[float]] = {}
# Separate lockout map: {ip: lockout_until (monotonic)}
_lockout_store: dict[str, float] = {}


def _get_settings():
    """Lazy import to avoid circular imports at module load time."""
    from app.core.config import settings
    return settings


def _client_ip(request) -> str:
    """Extract the real client IP, honouring common reverse-proxy headers."""
    # Respect X-Forwarded-For set by a trusted reverse proxy (nginx in front).
    forwarded_for = request.headers.get("x-forwarded-for")
    if forwarded_for:
        return forwarded_for.split(",")[0].strip()
    real_ip = request.headers.get("x-real-ip")
    if real_ip:
        return real_ip.strip()
    if request.client:
        return request.client.host
    return "unknown"


def check_rate_limit(request) -> None:
    """
    Raise an HTTPException(429) if the client IP is currently rate-limited.

    Call this *before* password verification in the login endpoint.
    """
    s = _get_settings()
    if not s.login_rate_limit_enabled:
        return

    ip = _client_ip(request)
    now = time.monotonic()

    # --- Check active lockout ---
    lockout_until = _lockout_store.get(ip)
    if lockout_until is not None:
        if now < lockout_until:
            retry_after = int(lockout_until - now) + 1
            _raise_429(retry_after)
        else:
            # Lockout expired – clean up
            del _lockout_store[ip]
            _failure_store.pop(ip, None)

    # --- Prune old failures outside the sliding window ---
    failures = _failure_store.get(ip)
    if failures:
        cutoff = now - s.login_rate_limit_window_seconds
        while failures and failures[0] < cutoff:
            failures.popleft()
        if not failures:
            del _failure_store[ip]
            failures = None

    # --- Check attempt count ---
    if failures and len(failures) >= s.login_rate_limit_max_attempts:
        # Transition to explicit lockout so subsequent requests don't have to
        # scan the deque and so the lockout survives window expiry.
        lockout_until = now + s.login_rate_limit_lockout_seconds
        _lockout_store[ip] = lockout_until
        _failure_store.pop(ip, None)
        logger.warning(
            "Login rate limit exceeded for IP %s – locked out for %ds",
            ip,
            s.login_rate_limit_lockout_seconds,
        )
        _raise_429(s.login_rate_limit_lockout_seconds)


def record_failure(request) -> None:
    """Record a failed login attempt for the client IP."""
    s = _get_settings()
    if not s.login_rate_limit_enabled:
        return

    ip = _client_ip(request)
    now = time.monotonic()

    if ip not in _failure_store:
        _failure_store[ip] = deque()

    _failure_store[ip].append(now)

    remaining = s.login_rate_limit_max_attempts - len(_failure_store[ip])
    logger.debug(
        "Failed login attempt from %s – %d/%d attempts in window",
        ip,
        len(_failure_store[ip]),
        s.login_rate_limit_max_attempts,
    )

    if remaining <= 2:
        logger.warning(
            "IP %s is approaching the login rate limit (%d attempts remaining)",
            ip,
            max(remaining, 0),
        )


def record_success(request) -> None:
    """Reset the failure counter for the client IP after a successful login."""
    s = _get_settings()
    if not s.login_rate_limit_enabled:
        return

    ip = _client_ip(request)
    _failure_store.pop(ip, None)
    _lockout_store.pop(ip, None)


def _raise_429(retry_after: int) -> None:
    from fastapi import HTTPException, status
    from fastapi.responses import JSONResponse

    raise HTTPException(
        status_code=status.HTTP_429_TOO_MANY_REQUESTS,
        detail={
            "code": "rate_limit_exceeded",
            "message": "Too many failed login attempts. Please try again later.",
        },
        headers={"Retry-After": str(retry_after)},
    )
