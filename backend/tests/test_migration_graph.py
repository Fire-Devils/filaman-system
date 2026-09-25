from pathlib import Path

from alembic.config import Config
from alembic.script import ScriptDirectory


def test_migration_graph_has_one_head():
    config = Config(str(Path(__file__).parents[1] / "alembic.ini"))

    assert ScriptDirectory.from_config(config).get_heads() == ["merge_labels_tags_20260916"]
