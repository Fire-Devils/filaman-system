"""Tests for the login rate limiter (app.core.rate_limit)."""

import time
import pytest
from unittest.mock import MagicMock
from httpx import AsyncClient

from app.core import rate_limit as rl


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_request(ip: str = "1.2.3.4"):
    req = MagicMock()
    req.headers = {}
    req.client = MagicMock()
    req.client.host = ip
    return req


def _clear_stores():
    rl._failure_store.clear()
    rl._lockout_store.clear()


# ---------------------------------------------------------------------------
# Unit tests for rate_limit module
# ---------------------------------------------------------------------------

class TestClientIp:
    def test_uses_x_forwarded_for(self):
        req = MagicMock()
        req.headers = {"x-forwarded-for": "10.0.0.1, 192.168.1.1"}
        req.client = None
        assert rl._client_ip(req) == "10.0.0.1"

    def test_uses_x_real_ip(self):
        req = MagicMock()
        req.headers = {"x-real-ip": "10.0.0.2"}
        req.client = None
        assert rl._client_ip(req) == "10.0.0.2"

    def test_falls_back_to_client_host(self):
        req = MagicMock()
        req.headers = {}
        req.client = MagicMock()
        req.client.host = "10.0.0.3"
        assert rl._client_ip(req) == "10.0.0.3"

    def test_returns_unknown_when_no_info(self):
        req = MagicMock()
        req.headers = {}
        req.client = None
        assert rl._client_ip(req) == "unknown"


class TestRateLimiter:
    def setup_method(self):
        _clear_stores()

    def test_no_block_below_limit(self, monkeypatch):
        monkeypatch.setattr("app.core.rate_limit._get_settings", lambda: MagicMock(
            login_rate_limit_enabled=True,
            login_rate_limit_max_attempts=5,
            login_rate_limit_window_seconds=300,
            login_rate_limit_lockout_seconds=300,
        ))
        req = _make_request()
        for _ in range(4):
            rl.record_failure(req)
        # Should not raise
        rl.check_rate_limit(req)

    def test_blocks_after_max_attempts(self, monkeypatch):
        from fastapi import HTTPException
        monkeypatch.setattr("app.core.rate_limit._get_settings", lambda: MagicMock(
            login_rate_limit_enabled=True,
            login_rate_limit_max_attempts=5,
            login_rate_limit_window_seconds=300,
            login_rate_limit_lockout_seconds=300,
        ))
        req = _make_request()
        for _ in range(5):
            rl.record_failure(req)
        with pytest.raises(HTTPException) as exc_info:
            rl.check_rate_limit(req)
        assert exc_info.value.status_code == 429
        assert "Retry-After" in exc_info.value.headers

    def test_success_resets_counter(self, monkeypatch):
        monkeypatch.setattr("app.core.rate_limit._get_settings", lambda: MagicMock(
            login_rate_limit_enabled=True,
            login_rate_limit_max_attempts=5,
            login_rate_limit_window_seconds=300,
            login_rate_limit_lockout_seconds=300,
        ))
        req = _make_request()
        for _ in range(4):
            rl.record_failure(req)
        rl.record_success(req)
        # After success, counter is reset – no block even at attempt 5
        rl.record_failure(req)
        rl.check_rate_limit(req)  # Should not raise

    def test_disabled_never_blocks(self, monkeypatch):
        monkeypatch.setattr("app.core.rate_limit._get_settings", lambda: MagicMock(
            login_rate_limit_enabled=False,
        ))
        req = _make_request()
        for _ in range(100):
            rl.record_failure(req)
        rl.check_rate_limit(req)  # Should not raise

    def test_old_failures_pruned_after_window(self, monkeypatch):
        """Failures older than the window are ignored."""
        from fastapi import HTTPException
        monkeypatch.setattr("app.core.rate_limit._get_settings", lambda: MagicMock(
            login_rate_limit_enabled=True,
            login_rate_limit_max_attempts=3,
            login_rate_limit_window_seconds=10,
            login_rate_limit_lockout_seconds=60,
        ))
        req = _make_request("2.3.4.5")

        # Inject old failures directly into the store (simulate past time)
        from collections import deque
        old_time = time.monotonic() - 20  # 20s ago, outside 10s window
        rl._failure_store["2.3.4.5"] = deque([old_time, old_time, old_time])

        # check_rate_limit should prune and not raise
        rl.check_rate_limit(req)

    def test_lockout_has_retry_after_header(self, monkeypatch):
        from fastapi import HTTPException
        monkeypatch.setattr("app.core.rate_limit._get_settings", lambda: MagicMock(
            login_rate_limit_enabled=True,
            login_rate_limit_max_attempts=2,
            login_rate_limit_window_seconds=300,
            login_rate_limit_lockout_seconds=120,
        ))
        req = _make_request("3.4.5.6")
        rl.record_failure(req)
        rl.record_failure(req)
        with pytest.raises(HTTPException) as exc_info:
            rl.check_rate_limit(req)
        assert exc_info.value.headers["Retry-After"] is not None
        retry = int(exc_info.value.headers["Retry-After"])
        assert 119 <= retry <= 121

    def test_different_ips_independent(self, monkeypatch):
        from fastapi import HTTPException
        monkeypatch.setattr("app.core.rate_limit._get_settings", lambda: MagicMock(
            login_rate_limit_enabled=True,
            login_rate_limit_max_attempts=3,
            login_rate_limit_window_seconds=300,
            login_rate_limit_lockout_seconds=300,
        ))
        req_a = _make_request("10.0.0.1")
        req_b = _make_request("10.0.0.2")
        for _ in range(3):
            rl.record_failure(req_a)
        # IP A is blocked
        with pytest.raises(HTTPException):
            rl.check_rate_limit(req_a)
        # IP B is NOT blocked
        rl.check_rate_limit(req_b)


# ---------------------------------------------------------------------------
# Integration tests via HTTP client
# ---------------------------------------------------------------------------

class TestLoginRateLimitIntegration:
    @pytest.mark.asyncio
    async def test_too_many_failed_logins_returns_429(
        self, client: AsyncClient, admin_user, monkeypatch
    ):
        """After LOGIN_RATE_LIMIT_MAX_ATTEMPTS failures, the endpoint returns 429."""
        # Use a small limit for the test
        monkeypatch.setattr("app.core.rate_limit._get_settings", lambda: MagicMock(
            login_rate_limit_enabled=True,
            login_rate_limit_max_attempts=3,
            login_rate_limit_window_seconds=300,
            login_rate_limit_lockout_seconds=300,
        ))
        _clear_stores()

        for i in range(3):
            resp = await client.post("/auth/login", json={
                "email": "test-admin@example.com",
                "password": "wrongpassword",
            })
            assert resp.status_code == 401, f"Attempt {i+1} should be 401"

        # 4th attempt must be rate-limited
        resp = await client.post("/auth/login", json={
            "email": "test-admin@example.com",
            "password": "wrongpassword",
        })
        assert resp.status_code == 429
        assert resp.json()["detail"]["code"] == "rate_limit_exceeded"
        assert "Retry-After" in resp.headers

    @pytest.mark.asyncio
    async def test_successful_login_resets_limit(
        self, client: AsyncClient, admin_user, monkeypatch
    ):
        """A successful login resets the failure counter for that IP."""
        monkeypatch.setattr("app.core.rate_limit._get_settings", lambda: MagicMock(
            login_rate_limit_enabled=True,
            login_rate_limit_max_attempts=3,
            login_rate_limit_window_seconds=300,
            login_rate_limit_lockout_seconds=300,
        ))
        _clear_stores()

        # 2 failures
        for _ in range(2):
            await client.post("/auth/login", json={
                "email": "test-admin@example.com",
                "password": "wrongpassword",
            })

        # Successful login resets the counter
        resp = await client.post("/auth/login", json={
            "email": "test-admin@example.com",
            "password": "testpassword",
        })
        assert resp.status_code == 200

        # 2 more failures should not trigger a lockout (counter was reset)
        for _ in range(2):
            resp = await client.post("/auth/login", json={
                "email": "test-admin@example.com",
                "password": "wrongpassword",
            })
            assert resp.status_code == 401

    @pytest.mark.asyncio
    async def test_rate_limit_disabled_allows_unlimited_attempts(
        self, client: AsyncClient, admin_user, monkeypatch
    ):
        """When rate limiting is disabled, no 429 is ever returned."""
        monkeypatch.setattr("app.core.rate_limit._get_settings", lambda: MagicMock(
            login_rate_limit_enabled=False,
        ))
        _clear_stores()

        for _ in range(20):
            resp = await client.post("/auth/login", json={
                "email": "test-admin@example.com",
                "password": "wrongpassword",
            })
            assert resp.status_code == 401
