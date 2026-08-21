from multiprocessing import get_context
from pathlib import Path

import pytest

from app.core.file_lock import FileLockBusy, exclusive_file_lock


def _hold_lock(path: str, ready, release) -> None:
    with exclusive_file_lock(Path(path)):
        ready.set()
        if not release.wait(timeout=10):
            raise RuntimeError("parent did not release child lock holder")


def test_exclusive_file_lock_rejects_second_holder(tmp_path: Path):
    path = tmp_path / "spoolman.lock"
    with (
        exclusive_file_lock(path),
        pytest.raises(FileLockBusy),
        exclusive_file_lock(path),
    ):
        raise AssertionError("second holder entered the lock")


def test_exclusive_file_lock_releases_after_context(tmp_path: Path):
    path = tmp_path / "spoolman.lock"
    with exclusive_file_lock(path):
        pass
    with exclusive_file_lock(path):
        pass


def test_exclusive_file_lock_rejects_another_process(tmp_path: Path):
    context = get_context("spawn")
    ready = context.Event()
    release = context.Event()
    process = context.Process(
        target=_hold_lock,
        args=(str(tmp_path / "spoolman.lock"), ready, release),
    )
    process.start()
    try:
        assert ready.wait(timeout=5), "child never acquired the lock"
        with pytest.raises(FileLockBusy), exclusive_file_lock(
            tmp_path / "spoolman.lock"
        ):
            raise AssertionError("parent entered a child-held lock")
    finally:
        release.set()
        process.join(timeout=5)
        if process.is_alive():
            process.kill()
            process.join(timeout=5)
    assert process.exitcode == 0
