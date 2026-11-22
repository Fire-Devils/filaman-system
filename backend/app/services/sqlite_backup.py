"""SQLite snapshots include committed WAL pages and preserve live connections."""

import os
import sqlite3
import time
from contextlib import closing
from datetime import UTC, datetime
from pathlib import Path
from urllib.parse import unquote, urlsplit
from uuid import uuid4

from sqlalchemy.engine import make_url

from app.core.config import settings
from app.services.backup_stream import atomic_binary_writer


def sqlite_database_path(database_url: str) -> Path | None:
    url = make_url(database_url)
    if url.get_backend_name() != "sqlite" or not url.database or url.database == ":memory:":
        return None
    arguments, options = url.get_dialect()().create_connect_args(url)
    name = arguments[0]
    if options.get("uri") and name.startswith("file:"):
        file_uri = urlsplit(name)
        if file_uri.netloc not in {"", "localhost"}:
            raise ValueError("SQLite file URI must be local")
        name = unquote(file_uri.path)
        if not name or name == ":memory:" or url.query.get("mode") == "memory":
            return None
    return Path(name).resolve()


def unique_backup_name(prefix: str, extension: str) -> str:
    return f"{prefix}_{datetime.now(UTC):%Y%m%d_%H%M%S}_{uuid4().hex}.{extension}"


def validate_restore_source(source: Path) -> None:
    with closing(sqlite3.connect(source.resolve().as_uri() + "?mode=ro", uri=True)) as reader:
        tables = {name for name, in reader.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if not {"users", "manufacturers", "filaments", "spools", "spool_statuses"}.issubset(tables):
            raise ValueError("The selected file is not a FilaMan database")
        if reader.execute("PRAGMA quick_check(1)").fetchone() != ("ok",):
            raise ValueError("The selected database failed SQLite's integrity check")


def copy_sqlite_database(source: Path, destination: Path) -> None:
    if source.resolve() == destination.resolve():
        raise ValueError("Source and destination must differ")
    deadline = time.monotonic() + 120

    def progress(status: int, _remaining: int, _total: int) -> None:
        if status != sqlite3.SQLITE_DONE and time.monotonic() >= deadline:
            raise TimeoutError("SQLite snapshot timed out")

    with closing(sqlite3.connect(source.resolve().as_uri() + "?mode=ro", uri=True)) as reader:
        if not reader.execute("PRAGMA page_count").fetchone()[0]:
            raise ValueError("Cannot copy an empty SQLite database")
        with closing(sqlite3.connect(destination)) as writer:
            reader.backup(writer, pages=256, progress=progress)


def write_sqlite_snapshot(source: Path, destination: Path) -> None:
    with atomic_binary_writer(destination) as temporary:
        copy_sqlite_database(source, Path(temporary.name))


def scheduled_backup() -> None:
    source = sqlite_database_path(settings.database_url)
    if source is not None and not os.environ.get("DATABASE_URL") and os.environ.get("DB_PATH"):
        source = Path(os.environ["DB_PATH"])
    if source is None:
        print("No file-backed SQLite database configured")
        return
    if not source.is_file() or not source.stat().st_size:
        print(f"No existing database to back up: {source}")
        return

    directory = Path(os.environ.get("BACKUP_DIR") or "/app/data/backups")
    keep = int(os.environ.get("MAX_BACKUPS") or 5)
    if keep < 0:
        raise ValueError("MAX_BACKUPS must be non-negative")
    directory.mkdir(parents=True, exist_ok=True)
    destination = directory / unique_backup_name("filaman", "db")
    write_sqlite_snapshot(source, destination)
    print(f"Backup created: {destination.name}")
    source = source.resolve()
    backups = []
    for path in directory.glob("filaman_*.db"):
        if path.resolve() != source:
            try:
                backups.append((path.stat().st_mtime_ns, path))
            except FileNotFoundError:
                continue  # Another backup already rotated this file.
    for _, expired in sorted(backups, reverse=True)[keep:]:
        expired.unlink(missing_ok=True)


if __name__ == "__main__":
    scheduled_backup()
