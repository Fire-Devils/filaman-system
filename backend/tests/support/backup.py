"""Read small test backups emitted by the production streaming writer."""

import json
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Literal

from app.api.v1.system import (
    COMPLETE_BACKUP_TABLES,
    INVENTORY_BACKUP_TABLES,
    _write_backup_file,
)


async def export_backup_data(db, *, kind: Literal["complete", "inventory"] = "complete"):
    tables = COMPLETE_BACKUP_TABLES if kind == "complete" else INVENTORY_BACKUP_TABLES
    data = {name: [] for name, _model in tables}
    with TemporaryDirectory() as directory:
        path = Path(directory) / "backup.jsonl"
        await _write_backup_file(db, path, kind=kind, metadata={}, tables=tables)
        with path.open() as stream:
            for line in stream:
                record = json.loads(line)
                if "table" in record:
                    data[record["table"]].append(record["row"])
    return data
