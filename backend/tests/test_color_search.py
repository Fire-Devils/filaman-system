from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.dialects import mysql
import pytest

from app.models import Filament
from app.services.color_search import filament_color_filter


@pytest.mark.parametrize('dialect', ['mysql', 'mariadb'])
def test_mysql_color_names_and_empty_names_use_binary_comparisons(dialect):
    predicate = filament_color_filter(["Red", "red", "Blå, Silk"], True, dialect)
    compiled = select(Filament.id).where(predicate).compile(dialect=mysql.dialect())
    assert "CAST(colors.name AS BINARY)" in str(compiled)
    assert "length(colors.name)" in str(compiled)
    values = list(compiled.params.values())
    assert [b"Red", b"red", "Blå, Silk".encode("utf-8")] in values
    assert 0 in values


def test_postgresql_rejects_an_id_that_cannot_bind_to_an_integer_column():
    with pytest.raises(HTTPException) as error:
        filament_color_filter(None, False, "postgresql", color_ids=[2**31])
    assert error.value.status_code == 422
