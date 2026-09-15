import pytest
from fastapi import HTTPException

from app.utils.query_params import parse_multi_int


def test_parse_multi_int_rejects_unicode_digits_it_cannot_parse():
    with pytest.raises(HTTPException) as error:
        parse_multi_int(["\u00b2"], "status_id")

    assert error.value.status_code == 422
