"""Translate the Spool Log's allowlisted column controls into SQL predicates."""

import json
import math
from datetime import UTC, date, datetime, time, timedelta
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import HTTPException
from sqlalchemy import and_, func, or_


async def spool_event_text_normalizer(db):
    if db.get_bind().dialect.name != "sqlite":
        return func.lower
    connection = await db.connection()
    # SQLite's built-in lower only folds ASCII; keep this function local to the log connection.
    await connection.run_sync(
        lambda conn: conn.connection.dbapi_connection.create_function(
            "filaman_lower",
            1,
            lambda value: None if value is None else str(value).lower(),
            deterministic=True,
        )
    )
    return func.filaman_lower


def spool_event_filter_conditions(raw, columns, timezone_name="UTC", lower=func.lower):
    if not raw:
        return []
    try:
        filters = json.loads(raw)
        if not isinstance(filters, dict) or len(filters) > len(columns):
            raise ValueError
        conditions = []
        for key, value in filters.items():
            if key not in columns or not isinstance(value, dict):
                raise ValueError
            column, kind = columns[key]
            values = column if isinstance(column, tuple) else (column,)
            if value.get("type") != kind:
                raise ValueError
            op = value.get("operator")
            first, second = value.get("value", ""), value.get("valueTo", "")
            if (
                not isinstance(first, str)
                or not isinstance(second, str)
                or len(first) > 200
                or len(second) > 200
            ):
                raise ValueError
            if op in ("isEmpty", "isNotEmpty"):
                empty = and_(*(item.is_(None) for item in values))
                if kind == "text":
                    empty = or_(empty, column == "")
                conditions.append(empty if op == "isEmpty" else ~empty)
            elif kind == "text":
                text = lower(func.coalesce(column, ""))
                first = first.lower()
                if op == "contains":
                    condition = text.contains(first, autoescape=True)
                elif op == "notContains":
                    condition = ~text.contains(first, autoescape=True)
                elif op == "equals":
                    condition = text == first
                elif op == "startsWith":
                    condition = text.startswith(first, autoescape=True)
                elif op == "endsWith":
                    condition = text.endswith(first, autoescape=True)
                else:
                    raise ValueError
                conditions.append(and_(column.is_not(None), column != "", condition))
            elif kind == "number":
                number = float(first)
                if not math.isfinite(number):
                    raise ValueError
                if op == "between":
                    upper = float(second)
                    if not math.isfinite(upper):
                        raise ValueError
                    conditions.append(
                        or_(
                            *(
                                item.between(min(number, upper), max(number, upper))
                                for item in values
                            )
                        )
                    )
                elif op in ("eq", "neq", "gt", "gte", "lt", "lte"):
                    comparisons = [
                        {
                            "eq": item == number,
                            "neq": item != number,
                            "gt": item > number,
                            "gte": item >= number,
                            "lt": item < number,
                            "lte": item <= number,
                        }[op]
                        for item in values
                    ]
                    if op == "neq":
                        # Exclude empty cells and any cell containing the rejected value.
                        conditions.append(
                            and_(
                                or_(*(item.is_not(None) for item in values)),
                                *(
                                    func.coalesce(comparison, True)
                                    for comparison in comparisons
                                ),
                            )
                        )
                    else:
                        conditions.append(or_(*comparisons))
                else:
                    raise ValueError
            else:
                zone = ZoneInfo(timezone_name)
                day = date.fromisoformat(first)
                last_day = date.fromisoformat(second) if op == "between" else day
                day, last_day = min(day, last_day), max(day, last_day)
                start = datetime.combine(day, time.min, zone).astimezone(UTC)
                next_day = datetime.combine(
                    last_day + timedelta(days=1), time.min, zone
                ).astimezone(UTC)
                if op in ("on", "between"):
                    condition = and_(column >= start, column < next_day)
                elif op == "before":
                    condition = column < start
                elif op == "after":
                    condition = column >= next_day
                else:
                    raise ValueError
                conditions.append(condition)
        return conditions
    except (
        ValueError,
        TypeError,
        OverflowError,
        RecursionError,
        ZoneInfoNotFoundError,
    ):
        raise HTTPException(
            status_code=422, detail="Invalid Spool Log column filters"
        ) from None
