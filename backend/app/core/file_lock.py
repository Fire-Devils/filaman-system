"""Small inter-process file locks."""

from __future__ import annotations

import fcntl
import os
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path


class FileLockBusy(RuntimeError):
    """The requested inter-process operation lock is already held."""


@contextmanager
def exclusive_file_lock(path: Path) -> Iterator[None]:
    with file_lock(path):
        yield


@contextmanager
def file_lock(path: Path, *, shared: bool = False, blocking: bool = False) -> Iterator[None]:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_CREAT | os.O_RDWR, 0o600)
    acquired = False
    try:
        try:
            mode = fcntl.LOCK_SH if shared else fcntl.LOCK_EX
            fcntl.flock(fd, mode if blocking else mode | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise FileLockBusy(str(path)) from exc
        acquired = True
        yield
    finally:
        if acquired:
            fcntl.flock(fd, fcntl.LOCK_UN)
        os.close(fd)
