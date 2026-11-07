from sqlalchemy import select
from sqlalchemy.dialects import mysql
import pytest

from app.models import Filament
from app.services.color_search import filament_color_filter


@pytest.mark.parametrize('dialect', ['mysql', 'mariadb'])
def test_mysql_color_names_and_empty_names_use_binary_comparisons(dialect):
    predicate = filament_color_filter(["Red", "red", "Blå, Silk"], True, dialect)
    compiled = select(Filament.id).where(predicate).compile(dialect=mysql.dialect())
    assert str(compiled).count("CAST(colors.name AS BINARY)") == 2
    values = list(compiled.params.values())
    assert [b"Red", b"red", "Blå, Silk".encode("utf-8")] in values
    assert b"" in values
