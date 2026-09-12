"""Free-text search over JSON-backed custom fields.

A custom field can reach a record three ways, and all three have to be
searchable (GitHub issue #147):

1. a system-wide definition in ``system_extra_fields``,
2. a definition that lives only on the record itself, in the
   ``custom_field_definitions`` JSON column,
3. no definition at all — an API client simply wrote a value into
   ``custom_fields``.

Only the *values* are matched, never the field keys, which is what makes a
search for a field name return nothing.
"""

from typing import Any

from sqlalchemy import ColumnElement, String, func, literal, or_, select, text
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import InstrumentedAttribute

from app.models import SystemExtraField

# Values reachable under these roots are integration metadata, not user fields.
_SKIPPED_ROOTS = frozenset(
    {
        "filamentdb_id",
        "spoolman_extra",
        "spoolman_external_id",
        "spoolman_id",
    }
)


async def searchable_custom_field_keys(
    db: AsyncSession, *, table: str, target_type: str
) -> list[str]:
    """Every custom-field key worth searching on ``table``.

    Unions the system-wide definitions with the keys actually present in the
    record-local ``custom_field_definitions`` and ``custom_fields`` columns, so
    a value is findable even when nothing ever declared its field.
    """
    keys = set(
        (
            await db.execute(
                select(SystemExtraField.key).where(
                    SystemExtraField.target_type == target_type
                )
            )
        )
        .scalars()
        .all()
    )

    dialect = db.get_bind().dialect.name
    for column in ("custom_field_definitions", "custom_fields"):
        if dialect == "postgresql":
            # json_object_keys raises on non-objects, hence the type guard.
            statement = text(
                f"SELECT DISTINCT json_object_keys({column}::json) AS key "
                f"FROM {table} "
                f"WHERE {column} IS NOT NULL "
                f"AND json_typeof({column}::json) = 'object'"
            )
        else:
            statement = text(
                f"SELECT DISTINCT je.key AS key "
                f"FROM {table}, json_each({table}.{column}) AS je "
                f"WHERE {table}.{column} IS NOT NULL "
                f"AND json_type({table}.{column}) = 'object'"
            )
        keys.update((await db.execute(statement)).scalars().all())

    return sorted(
        key
        for key in keys
        if key and key.split(".")[0] not in _SKIPPED_ROOTS
    )


def _value_expression(
    column: InstrumentedAttribute[Any], key: str
) -> ColumnElement[Any]:
    """Extract the value at ``key``, following dotted keys into nested objects.

    ``validate_custom_field_path`` accepts ``a.b`` as a nested path, so indexing
    the column with the whole key would look for a flat ``"a.b"`` member and
    never match.
    """
    expression = column
    for segment in key.split("."):
        expression = expression[segment]
    return expression.as_string()


def custom_field_conditions(
    column: InstrumentedAttribute[Any],
    keys: list[str],
    search: str,
    *,
    dialect: str,
) -> list[ColumnElement[bool]]:
    """OR-conditions matching ``search`` against the values behind ``keys``."""
    conditions: list[ColumnElement[bool]] = []
    stripped = search.strip()
    # SQLite renders objects and arrays without spaces, PostgreSQL with them.
    # Comparing both sides space-free keeps the same query working on either.
    compact_term = f"%{stripped.replace(' ', '')}%"
    boolean_aliases = _boolean_aliases(stripped, dialect)

    for key in keys:
        value = _value_expression(column, key)
        conditions.append(
            func.replace(value.cast(String), " ", "").ilike(compact_term)
        )
        for alias in boolean_aliases:
            conditions.append(value.cast(String) == literal(alias))

    return conditions


def _boolean_aliases(search: str, dialect: str) -> tuple[str, ...]:
    """How the searched term shows up for a JSON boolean in this dialect.

    SQLite's json_extract turns ``true``/``false`` into ``1``/``0``, PostgreSQL
    keeps the words, so searching "true" has to look for both spellings.
    """
    lowered = search.lower()
    if lowered in ("true", "1"):
        return ("1",) if dialect != "postgresql" else ("true",)
    if lowered in ("false", "0"):
        return ("0",) if dialect != "postgresql" else ("false",)
    return ()


def any_custom_field_matches(
    column: InstrumentedAttribute[Any],
    keys: list[str],
    search: str,
    *,
    dialect: str,
) -> ColumnElement[bool] | None:
    """``custom_field_conditions`` collapsed into a single OR, or None."""
    conditions = custom_field_conditions(column, keys, search, dialect=dialect)
    return or_(*conditions) if conditions else None
