import os
import shutil
from pathlib import Path
from urllib.parse import urlsplit

from pydantic import Field, SecretStr, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

REPO_ROOT = Path(__file__).resolve().parents[2]


def resolve_db_path(repo_root: Path, relative_path: str) -> Path:
    relative = Path(relative_path)
    resolved = (repo_root / relative).resolve()
    if relative.is_absolute() or not resolved.is_relative_to(repo_root.resolve()):
        raise ValueError("DB path must stay under repository root")
    return resolved


class Settings(BaseSettings):
    model_config = SettingsConfigDict(extra="ignore", env_file=REPO_ROOT / ".env")
    repo_root: Path = REPO_ROOT
    db_path: str = Field(
        "data/interface-ai.sqlite3", validation_alias="INTERFACE_DB_PATH"
    )
    environment: str = Field("local", validation_alias="INTERFACE_ENV")
    cors_origins: list[str] = Field(
        default_factory=list, validation_alias="INTERFACE_CORS_ORIGINS"
    )
    node_bin: str = Field(
        default_factory=lambda: shutil.which("node") or "node",
        validation_alias="INTERFACE_NODE_BIN",
    )
    headless: bool = Field(False, validation_alias="INTERFACE_BROWSER_HEADLESS")
    max_tool_calls: int = Field(40, gt=0, validation_alias="INTERFACE_MAX_TOOL_CALLS")
    runtime_api_url: str = Field(
        default_factory=lambda: "http://127.0.0.1:" + os.environ.get("PORT", "8000"),
        validation_alias="INTERFACE_RUNTIME_API_URL",
    )
    review_timeout_seconds: int = Field(
        300, ge=1, le=3600, validation_alias="INTERFACE_REVIEW_TIMEOUT_SECONDS"
    )
    minio_endpoint: str | None = None
    minio_public_endpoint: str | None = None
    minio_secure: bool = True
    minio_public_secure: bool = True
    minio_region: str | None = None
    minio_bucket: str | None = None
    minio_access_key: SecretStr | None = None
    minio_secret_key: SecretStr | None = None
    openrouter_api_key: SecretStr | None = None
    openrouter_model: str | None = Field(None, repr=False)

    @property
    def database_path(self):
        return resolve_db_path(self.repo_root, self.db_path)

    @property
    def storage_configured(self):
        return all(
            (
                self.minio_endpoint,
                self.minio_public_endpoint,
                self.minio_bucket,
                self.minio_access_key,
                self.minio_secret_key,
            )
        )

    @model_validator(mode="after")
    def validate_paths(self):
        path = self.database_path
        if self.environment not in ("local", "railway"):
            raise ValueError("Invalid execution environment")
        if self.environment == "railway":
            if (
                Path(os.environ.get("RAILWAY_VOLUME_MOUNT_PATH", "/missing")).resolve()
                != path.parent
            ):
                raise ValueError("Railway persistent volume must mount at DB directory")
            self.headless = True
        callback = urlsplit(self.runtime_api_url)
        if (
            callback.scheme not in ("http", "https")
            or not callback.netloc
            or callback.username
            or callback.password
            or callback.query
            or callback.fragment
            or callback.path not in ("", "/")
        ):
            raise ValueError(
                "Runtime API URL must be an HTTP origin without credentials"
            )
        for origin in self.cors_origins:
            parsed = urlsplit(origin)
            if (
                parsed.scheme not in ("http", "https")
                or not parsed.netloc
                or parsed.path not in ("", "/")
                or parsed.username
            ):
                raise ValueError("CORS entries must be exact HTTP origins")
        return self
