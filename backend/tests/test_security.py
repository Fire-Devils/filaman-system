import pytest

from app.core.security import (
    hash_password,
    verify_password,
    hash_password_async,
    verify_password_async,
    generate_token_secret,
    hash_token,
    verify_token,
    is_argon2_hash,
    parse_token,
    Principal,
    generate_device_code,
)


class TestPasswordHashing:
    """Test synchronous password hashing functions."""

    @pytest.mark.asyncio
    async def test_hash_password_returns_string(self):
        """Test that hash_password returns a string."""
        password = "testpassword123"
        hashed = hash_password(password)
        
        assert isinstance(hashed, str)
        assert len(hashed) > 0

    @pytest.mark.asyncio
    async def test_hash_password_not_plaintext(self):
        """Test that hash_password doesn't return the plaintext password."""
        password = "testpassword123"
        hashed = hash_password(password)
        
        assert hashed != password

    @pytest.mark.asyncio
    async def test_hash_password_returns_argon2(self):
        """Test that hash_password returns argon2 hash."""
        password = "testpassword123"
        hashed = hash_password(password)
        
        assert hashed.startswith("$argon2")

    @pytest.mark.asyncio
    async def test_verify_password_correct(self):
        """Test that verify_password returns True for correct password."""
        password = "testpassword123"
        hashed = hash_password(password)
        
        result = verify_password(password, hashed)
        
        assert result is True

    @pytest.mark.asyncio
    async def test_verify_password_wrong(self):
        """Test that verify_password returns False for wrong password."""
        password = "testpassword123"
        hashed = hash_password(password)
        
        result = verify_password("wrongpassword", hashed)
        
        assert result is False

    @pytest.mark.asyncio
    async def test_verify_password_empty_password(self):
        """Test that verify_password returns False for empty password."""
        password = "testpassword123"
        hashed = hash_password(password)
        
        result = verify_password("", hashed)
        
        assert result is False

    @pytest.mark.asyncio
    async def test_hash_password_different_inputs(self):
        """Test that different passwords produce different hashes."""
        hash1 = hash_password("password1")
        hash2 = hash_password("password2")
        
        assert hash1 != hash2


class TestAsyncPasswordHashing:
    """Test asynchronous password hashing functions."""

    @pytest.mark.asyncio
    async def test_hash_password_async_returns_string(self):
        """Test that hash_password_async returns a string."""
        password = "testpassword123"
        hashed = await hash_password_async(password)
        
        assert isinstance(hashed, str)
        assert len(hashed) > 0

    @pytest.mark.asyncio
    async def test_hash_password_async_returns_argon2(self):
        """Test that hash_password_async returns argon2 hash."""
        password = "testpassword123"
        hashed = await hash_password_async(password)
        
        assert hashed.startswith("$argon2")

    @pytest.mark.asyncio
    async def test_verify_password_async_correct(self):
        """Test that verify_password_async returns True for correct password."""
        password = "testpassword123"
        hashed = await hash_password_async(password)
        
        result = await verify_password_async(password, hashed)
        
        assert result is True

    @pytest.mark.asyncio
    async def test_verify_password_async_wrong(self):
        """Test that verify_password_async returns False for wrong password."""
        password = "testpassword123"
        hashed = await hash_password_async(password)
        
        result = await verify_password_async("wrongpassword", hashed)
        
        assert result is False

    @pytest.mark.asyncio
    async def test_async_hash_compatible_with_sync_verify(self):
        """Test that async hash is compatible with sync verify."""
        password = "testpassword123"
        hashed = await hash_password_async(password)
        
        result = verify_password(password, hashed)
        
        assert result is True

    @pytest.mark.asyncio
    async def test_sync_hash_compatible_with_async_verify(self):
        """Test that sync hash is compatible with async verify."""
        password = "testpassword123"
        hashed = hash_password(password)
        
        result = await verify_password_async(password, hashed)
        
        assert result is True


class TestTokenHashing:
    """Test token secret generation and hashing functions."""

    @pytest.mark.asyncio
    async def test_generate_token_secret_returns_string(self):
        """Test that generate_token_secret returns a string."""
        secret = generate_token_secret()
        
        assert isinstance(secret, str)
        assert len(secret) > 0

    @pytest.mark.asyncio
    async def test_generate_token_secret_sufficient_length(self):
        """Test that generate_token_secret returns sufficiently long string."""
        secret = generate_token_secret()
        
        # token_urlsafe(32) produces at least 42 characters
        assert len(secret) >= 40

    @pytest.mark.asyncio
    async def test_generate_token_secret_url_safe(self):
        """Test that generate_token_secret returns URL-safe string."""
        secret = generate_token_secret()
        
        # URL-safe alphabet: a-z, A-Z, 0-9, -, _
        # token_urlsafe should only contain these characters
        import string
        valid_chars = set(string.ascii_letters + string.digits + "-_")
        assert all(c in valid_chars for c in secret)

    @pytest.mark.asyncio
    async def test_generate_token_secret_unique(self):
        """Test that generate_token_secret produces unique values."""
        secrets_list = [generate_token_secret() for _ in range(10)]
        
        # All should be unique
        assert len(set(secrets_list)) == len(secrets_list)

    @pytest.mark.asyncio
    async def test_hash_token_returns_string(self):
        """Test that hash_token returns a string."""
        secret = generate_token_secret()
        hashed = hash_token(secret)
        
        assert isinstance(hashed, str)

    @pytest.mark.asyncio
    async def test_hash_token_returns_hex(self):
        """Test that hash_token returns hexadecimal string."""
        secret = generate_token_secret()
        hashed = hash_token(secret)
        
        # SHA-256 produces 64 hex characters
        assert len(hashed) == 64
        assert all(c in "0123456789abcdef" for c in hashed)

    @pytest.mark.asyncio
    async def test_hash_token_different_inputs(self):
        """Test that different secrets produce different hashes."""
        secret1 = generate_token_secret()
        secret2 = generate_token_secret()
        
        hash1 = hash_token(secret1)
        hash2 = hash_token(secret2)
        
        assert hash1 != hash2

    @pytest.mark.asyncio
    async def test_verify_token_correct(self):
        """Test that verify_token returns True for correct secret."""
        secret = generate_token_secret()
        token_hash = hash_token(secret)
        
        result = verify_token(secret, token_hash)
        
        assert result is True

    @pytest.mark.asyncio
    async def test_verify_token_wrong_secret(self):
        """Test that verify_token returns False for wrong secret."""
        secret1 = generate_token_secret()
        secret2 = generate_token_secret()
        token_hash = hash_token(secret1)
        
        result = verify_token(secret2, token_hash)
        
        assert result is False

    @pytest.mark.asyncio
    async def test_verify_token_empty_secret(self):
        """Test that verify_token returns False for empty secret."""
        secret = generate_token_secret()
        token_hash = hash_token(secret)
        
        result = verify_token("", token_hash)
        
        assert result is False


class TestArgon2Detection:
    """Test argon2 hash detection."""

    @pytest.mark.asyncio
    async def test_is_argon2_hash_valid(self):
        """Test that is_argon2_hash returns True for argon2 hash."""
        password = "testpassword123"
        hashed = hash_password(password)
        
        result = is_argon2_hash(hashed)
        
        assert result is True

    @pytest.mark.asyncio
    async def test_is_argon2_hash_invalid_sha256(self):
        """Test that is_argon2_hash returns False for SHA-256 hash."""
        secret = generate_token_secret()
        sha_hash = hash_token(secret)
        
        result = is_argon2_hash(sha_hash)
        
        assert result is False

    @pytest.mark.asyncio
    async def test_is_argon2_hash_invalid_plaintext(self):
        """Test that is_argon2_hash returns False for plaintext."""
        result = is_argon2_hash("plaintext_password")
        
        assert result is False

    @pytest.mark.asyncio
    async def test_is_argon2_hash_empty_string(self):
        """Test that is_argon2_hash returns False for empty string."""
        result = is_argon2_hash("")
        
        assert result is False


class TestTokenParsing:
    """Test token parsing."""

    @pytest.mark.asyncio
    async def test_parse_token_valid_session(self):
        """Test parsing valid session token."""
        token = "sess.123.abcdef123456"
        
        result = parse_token(token)
        
        assert result is not None
        prefix, token_id, secret = result
        assert prefix == "sess"
        assert token_id == 123
        assert secret == "abcdef123456"

    @pytest.mark.asyncio
    async def test_parse_token_valid_api_key(self):
        """Test parsing valid API key token."""
        token = "uak.456.xyz789"
        
        result = parse_token(token)
        
        assert result is not None
        prefix, token_id, secret = result
        assert prefix == "uak"
        assert token_id == 456
        assert secret == "xyz789"

    @pytest.mark.asyncio
    async def test_parse_token_valid_device(self):
        """Test parsing valid device token."""
        token = "dev.789.secret123"
        
        result = parse_token(token)
        
        assert result is not None
        prefix, token_id, secret = result
        assert prefix == "dev"
        assert token_id == 789
        assert secret == "secret123"

    @pytest.mark.asyncio
    async def test_parse_token_invalid_prefix(self):
        """Test parsing token with invalid prefix."""
        token = "invalid.123.secret"
        
        result = parse_token(token)
        
        assert result is None

    @pytest.mark.asyncio
    async def test_parse_token_non_numeric_id(self):
        """Test parsing token with non-numeric ID."""
        token = "sess.abc.secret"
        
        result = parse_token(token)
        
        assert result is None

    @pytest.mark.asyncio
    async def test_parse_token_too_few_parts(self):
        """Test parsing token with too few parts."""
        token = "sess.123"
        
        result = parse_token(token)
        
        assert result is None

    @pytest.mark.asyncio
    async def test_parse_token_too_many_parts(self):
        """Test parsing token with too many parts."""
        token = "sess.123.secret.extra"
        
        result = parse_token(token)
        
        assert result is None

    @pytest.mark.asyncio
    async def test_parse_token_empty_string(self):
        """Test parsing empty token."""
        token = ""
        
        result = parse_token(token)
        
        assert result is None

    @pytest.mark.asyncio
    async def test_parse_token_zero_id(self):
        """Test parsing token with zero ID."""
        token = "sess.0.secret"
        
        result = parse_token(token)
        
        assert result is not None
        prefix, token_id, secret = result
        assert token_id == 0

    @pytest.mark.asyncio
    async def test_parse_token_negative_id(self):
        """Test parsing token with negative ID."""
        token = "sess.-123.secret"
        
        result = parse_token(token)
        
        assert result is not None
        prefix, token_id, secret = result
        assert token_id == -123


class TestPrincipalDataclass:
    """Test Principal dataclass."""

    @pytest.mark.asyncio
    async def test_principal_basic_construction(self):
        """Test basic Principal construction."""
        principal = Principal(auth_type="session", user_id=1)
        
        assert principal.auth_type == "session"
        assert principal.user_id == 1

    @pytest.mark.asyncio
    async def test_principal_default_values(self):
        """Test Principal default values."""
        principal = Principal(auth_type="session")
        
        assert principal.auth_type == "session"
        assert principal.user_id is None
        assert principal.device_id is None
        assert principal.api_key_id is None
        assert principal.session_id is None
        assert principal.is_superadmin is False
        assert principal.scopes is None
        assert principal.user_email is None
        assert principal.user_display_name is None
        assert principal.user_language == "en"
        assert principal.needs_cookie_extension is False

    @pytest.mark.asyncio
    async def test_principal_all_fields(self):
        """Test Principal with all fields set."""
        scopes = ["read:spool", "write:spool"]
        principal = Principal(
            auth_type="session",
            user_id=1,
            device_id=2,
            api_key_id=3,
            session_id=4,
            is_superadmin=True,
            scopes=scopes,
            user_email="user@example.com",
            user_display_name="John Doe",
            user_language="de",
            needs_cookie_extension=True,
        )
        
        assert principal.auth_type == "session"
        assert principal.user_id == 1
        assert principal.device_id == 2
        assert principal.api_key_id == 3
        assert principal.session_id == 4
        assert principal.is_superadmin is True
        assert principal.scopes == scopes
        assert principal.user_email == "user@example.com"
        assert principal.user_display_name == "John Doe"
        assert principal.user_language == "de"
        assert principal.needs_cookie_extension is True

    @pytest.mark.asyncio
    async def test_principal_device_type(self):
        """Test Principal for device authentication."""
        principal = Principal(auth_type="device", device_id=10)
        
        assert principal.auth_type == "device"
        assert principal.device_id == 10
        assert principal.user_id is None

    @pytest.mark.asyncio
    async def test_principal_api_key_type(self):
        """Test Principal for API key authentication."""
        principal = Principal(auth_type="api_key", user_id=5, api_key_id=20)
        
        assert principal.auth_type == "api_key"
        assert principal.user_id == 5
        assert principal.api_key_id == 20


class TestDeviceCodeGeneration:
    """Test device code generation."""

    @pytest.mark.asyncio
    async def test_generate_device_code_length(self):
        """Test that generate_device_code returns 6 characters."""
        code = generate_device_code()
        
        assert len(code) == 6

    @pytest.mark.asyncio
    async def test_generate_device_code_alphanumeric(self):
        """Test that generate_device_code returns only alphanumeric uppercase + digits."""
        code = generate_device_code()
        
        # Valid alphabet: 0-9 and A-Z (uppercase only, no lowercase)
        valid_chars = set("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ")
        assert all(c in valid_chars for c in code)

    @pytest.mark.asyncio
    async def test_generate_device_code_uppercase(self):
        """Test that generate_device_code contains uppercase letters (not lowercase)."""
        codes = [generate_device_code() for _ in range(100)]
        
        # At least some should have letters
        has_letters = any(any(c.isalpha() for c in code) for code in codes)
        assert has_letters
        
        # All should be uppercase if they have letters
        for code in codes:
            assert code == code.upper()

    @pytest.mark.asyncio
    async def test_generate_device_code_unique(self):
        """Test that generate_device_code produces unique values."""
        codes = [generate_device_code() for _ in range(100)]
        
        # Most should be unique (statistically, collision probability is very low)
        unique_codes = len(set(codes))
        assert unique_codes >= 95  # Allow for rare collisions

    @pytest.mark.asyncio
    async def test_generate_device_code_no_lowercase(self):
        """Test that generate_device_code never produces lowercase letters."""
        codes = [generate_device_code() for _ in range(50)]
        
        for code in codes:
            assert not any(c.islower() for c in code)
