import codecs
import json
import os
import tempfile
from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from pathlib import Path
from typing import Any, BinaryIO, Literal, cast

BACKUP_FORMAT = "filaman-backup"
BACKUP_VERSION = 1
MAX_BACKUP_RECORD_BYTES = 8 * 1024 * 1024


class BackupStreamError(ValueError):
    pass


class BackupRecordTooLarge(BackupStreamError):
    pass


def write_json(stream: BinaryIO, value: Any) -> None:
    stream.writelines(
        chunk.encode("utf-8")
        for chunk in json.JSONEncoder(separators=(",", ":")).iterencode(value)
    )


def write_record(stream: BinaryIO, record: Mapping[str, Any]) -> None:
    encoded = json.dumps(record, separators=(",", ":")).encode("utf-8") + b"\n"
    if len(encoded) > MAX_BACKUP_RECORD_BYTES:
        raise BackupRecordTooLarge(
            f"Backup record exceeds {MAX_BACKUP_RECORD_BYTES} bytes"
        )
    stream.write(encoded)


def read_record(stream: BinaryIO) -> dict[str, Any] | None:
    encoded = stream.readline(MAX_BACKUP_RECORD_BYTES + 1)
    if not encoded:
        return None
    if len(encoded) > MAX_BACKUP_RECORD_BYTES or not encoded.endswith(b"\n"):
        raise BackupStreamError(
            f"Backup record exceeds {MAX_BACKUP_RECORD_BYTES} bytes"
        )
    try:
        record = json.loads(encoded)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise BackupStreamError("Invalid backup JSON record") from exc
    if not isinstance(record, dict):
        raise BackupStreamError("Backup records must be JSON objects")
    return record


def detect_backup_format(
    stream: BinaryIO,
) -> Literal["jsonl", "legacy-json"]:
    position = stream.tell()
    try:
        encoded = stream.readline(MAX_BACKUP_RECORD_BYTES + 1)
        if len(encoded) > MAX_BACKUP_RECORD_BYTES or not encoded.endswith(b"\n"):
            return "legacy-json"
        try:
            header = json.loads(encoded)
        except (UnicodeDecodeError, json.JSONDecodeError):
            return "legacy-json"
        return (
            "jsonl"
            if isinstance(header, dict) and header.get("format") == BACKUP_FORMAT
            else "legacy-json"
        )
    finally:
        stream.seek(position)


@contextmanager
def atomic_binary_writer(path: Path) -> Iterator[BinaryIO]:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        mode="w+b",
        dir=path.parent,
        prefix=f".{path.name}.",
        delete=False,
    ) as temporary:
        temporary_path = Path(temporary.name)
        try:
            yield cast(BinaryIO, temporary)
            temporary.flush()
            os.fsync(temporary.fileno())
            temporary.close()
            os.replace(temporary_path, path)
        except BaseException:
            temporary.close()
            temporary_path.unlink(missing_ok=True)
            raise


class LegacyBackupJSONError(BackupStreamError):
    """A legacy document is not valid JSON (distinct from a wrong backup shape)."""


class _LegacyJSONReader:
    """Frame the backup envelope; stdlib decodes each key and row value."""

    def __init__(self, stream: BinaryIO):
        self.stream = stream
        prefix = stream.read(4)
        self.decoder = codecs.getincrementaldecoder(json.detect_encoding(prefix))()
        self.buffer = self.decoder.decode(prefix)
        self.eof = False
        self.position = 0
        self.json_decoder = json.JSONDecoder()

    def read_more(self, minimum: int = 1) -> None:
        chunks = []
        size = 0
        while size < minimum and not self.eof:
            chunk = self.stream.read(65536)
            self.eof = not chunk
            decoded = self.decoder.decode(chunk, final=self.eof)
            chunks.append(decoded)
            size += len(decoded)
        self.buffer = self.buffer[self.position :] + "".join(chunks)
        self.position = 0

    def peek(self) -> str:
        while True:
            while (
                self.position < len(self.buffer)
                and self.buffer[self.position] in " \t\r\n"
            ):
                self.position += 1
            if self.position < len(self.buffer) or self.eof:
                return self.buffer[self.position : self.position + 1]
            self.read_more()

    def expect(self, token: str) -> None:
        if self.peek() != token:
            raise LegacyBackupJSONError("Invalid JSON file")
        self.position += 1

    def value(self) -> Any:
        self.peek()
        while True:
            try:
                value, end = self.json_decoder.raw_decode(self.buffer, self.position)
                # A number can end exactly at a read boundary, or continue with
                # a decimal/exponent. Read ahead before accepting its prefix.
                if (end < len(self.buffer) and self.buffer[end] in " \t\r\n,:]}") or (
                    end == len(self.buffer) and self.eof
                ):
                    self.position = end
                    return value
            except json.JSONDecodeError as exc:
                # Incomplete literals/escapes lie at the end; an unfinished
                # string is the only valid value whose error points far back.
                if exc.msg != "Unterminated string starting at" and exc.pos + 8 < len(
                    self.buffer
                ):
                    raise LegacyBackupJSONError("Invalid JSON file") from exc
            if self.eof:
                raise LegacyBackupJSONError("Invalid JSON file")
            # Double buffered input between retries; both joining chunks and
            # decoding oversized custom fields remain linear in their size.
            self.read_more(max(65536, len(self.buffer) - self.position))

    def members(self) -> Iterator[str]:
        self.expect("{")
        if self.peek() != "}":
            while True:
                key = self.value()
                if not isinstance(key, str):
                    raise LegacyBackupJSONError("Invalid JSON file")
                self.expect(":")
                yield key
                if self.peek() == "}":
                    break
                self.expect(",")
        self.expect("}")

    def items(self) -> Iterator[Any]:
        self.expect("[")
        if self.peek() != "]":
            while True:
                yield self.value()
                if self.peek() == "]":
                    break
                self.expect(",")
        self.expect("]")

    def skip(self) -> None:
        if self.peek() == "{":
            for _key in self.members():
                self.skip()
        elif self.peek() == "[":
            self.expect("[")
            if self.peek() != "]":
                while True:
                    self.skip()
                    if self.peek() == "]":
                        break
                    self.expect(",")
            self.expect("]")
        else:
            self.value()


@contextmanager
def read_legacy_backup(
    stream: BinaryIO, table_names: set[str]
) -> Iterator[tuple[dict[str, Any], dict[str, BinaryIO]]]:
    """Stage rows on disk so legacy table/key order never dictates FK order.

    Memory is bounded by the current JSON value and read buffer, not the backup.
    Temporary streams close on parse failures, import failures, and success.
    """
    tables: dict[str, BinaryIO] | None = None
    try:
        try:
            reader = _LegacyJSONReader(stream)
            metadata = None
            if reader.peek() != "{":
                reader.value()
                raise BackupStreamError("Backup must be a JSON object")
            for key in reader.members():
                if key == "metadata":
                    metadata = reader.value()
                elif key == "data":
                    if tables is not None:
                        for table in tables.values():
                            table.close()
                    tables = {}
                    if reader.peek() != "{":
                        raise BackupStreamError("Backup data must be an object")
                    for table_name in reader.members():
                        if table_name not in table_names:
                            reader.skip()
                            continue
                        if reader.peek() != "[":
                            raise BackupStreamError(
                                f"Backup table {table_name} must be a list"
                            )
                        if table_name in tables:
                            tables[table_name].close()
                        # The outer finally owns only the current table files.
                        table = tempfile.TemporaryFile(mode="w+b")  # noqa: SIM115
                        tables[table_name] = table
                        for row in reader.items():
                            if not isinstance(row, dict):
                                raise BackupStreamError(
                                    f"Backup row for {table_name} must be an object"
                                )
                            write_json(table, row)
                            table.write(b"\n")
                            del row
                        table.seek(0)
                else:
                    reader.skip()
            if reader.peek():
                raise LegacyBackupJSONError("Invalid JSON file")
            if not isinstance(metadata, dict) or tables is None:
                raise BackupStreamError(
                    "Backup file must contain 'metadata' and 'data' objects"
                )
        except (UnicodeError, json.JSONDecodeError) as exc:
            raise LegacyBackupJSONError("Invalid JSON file") from exc
        del reader
        yield metadata, tables
    finally:
        if tables is not None:
            for table in tables.values():
                table.close()
