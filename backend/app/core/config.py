from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
    )

    app_name: str = "FilaMan"
    debug: bool = False

    log_level: str = "INFO"
    log_format: str = "json"

    database_url: str = "sqlite+aiosqlite:///./filaman.db"

    admin_email: str | None = None
    admin_password: str | None = None
    admin_display_name: str | None = None
    admin_language: str = "en"
    admin_superadmin: bool = True

    secret_key: str = "change-me-in-production"
    csrf_secret_key: str = "change-me-in-production"

    cors_origins: str = ""


settings = Settings()
