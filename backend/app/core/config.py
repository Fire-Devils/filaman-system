from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

# Go up three levels from config.py -> core -> app -> .env
PROJECT_ROOT = Path(__file__).parent.parent.parent.parent
ENV_PATH = PROJECT_ROOT / ".env"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=ENV_PATH,

        env_file_encoding="utf-8",
        case_sensitive=False,
    )

    app_name: str = "FilaMan"
    debug: bool = False

    log_level: str = "INFO"
    log_format: str = "json"

    # Default to a file in the project root if not specified in env
    database_url: str = f"sqlite+aiosqlite:///{PROJECT_ROOT}/filaman.db"

    admin_email: str | None = None
    admin_password: str | None = None
    admin_display_name: str | None = None
    admin_language: str = "en"
    admin_superadmin: bool = True

    secret_key: str = "change-me-in-production"
    csrf_secret_key: str = "change-me-in-production"

    cors_origins: str = ""


settings = Settings()
