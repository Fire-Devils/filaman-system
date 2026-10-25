"""Read-only native metrics; remaining_weight_g is already net filament weight."""

import math
import sys
from decimal import Decimal

from sqlalchemy import (
    Double,
    Float,
    Numeric,
    and_,
    case,
    cast,
    func,
    literal,
    or_,
    select,
)

from app.models import Filament, Spool, SpoolStatus

# MySQL rounds bound Decimals beyond 65 digits; scientific literals retain the bounds.
_FLOAT_MAX = literal(Decimal(str(sys.float_info.max)), literal_execute=True)
_FLOAT_MIN = literal(Decimal(str(sys.float_info.min)), literal_execute=True)


def _usable(value, *, positive=False):
    return and_(
        value > 0 if positive else value >= 0,
        value <= _FLOAT_MAX,
    )


def spool_metric_expressions(dialect_name="sqlite"):
    # Numeric intermediates avoid PostgreSQL floating-point overflow on legacy data.
    mysql = dialect_name in {"mysql", "mariadb"}
    numeric = Double if mysql else Numeric
    inferred = and_(
        Spool.remaining_weight_g.is_(None),
        Spool.status_id.in_(select(SpoolStatus.id).where(SpoolStatus.key == "new")),
        _usable(Filament.raw_material_weight_g, positive=True),
    )
    effective = case(
        (inferred, Filament.raw_material_weight_g), else_=Spool.remaining_weight_g
    )
    grams = cast(effective, numeric)
    gross = cast(Spool.initial_total_weight_g, numeric)
    tare = cast(Spool.empty_spool_weight_g, numeric)
    capacity = case(
        (inferred, cast(Filament.raw_material_weight_g, numeric)),
        (
            and_(
                _usable(Spool.initial_total_weight_g),
                _usable(Spool.empty_spool_weight_g),
                gross > tare,
            ),
            gross - tare,
        ),
        (
            _usable(Filament.raw_material_weight_g, positive=True),
            cast(Filament.raw_material_weight_g, numeric),
        ),
    )
    percent = case(
        (
            and_(_usable(effective), capacity > 0),
            case(
                (grams >= capacity, Decimal(100)),
                else_=grams / func.nullif(capacity, 0) * 100,
            ),
        ),
    )
    percent = case(
        (
            and_(
                _usable(percent),
                or_(grams == 0, percent >= _FLOAT_MIN),
            ),
            percent,
        )
    )
    diameter = cast(Filament.diameter_mm, numeric)
    density = cast(Filament.density_g_cm3, numeric)
    log_length = (
        func.ln(func.nullif(grams, 0))
        + math.log(4 / math.pi)
        - 2 * func.ln(func.nullif(diameter, 0))
        - func.ln(func.nullif(density, 0))
    )
    # MySQL's unqualified DECIMAL cast rounds dimensions to integers; bounded log math avoids DOUBLE overflow.
    mysql_length = (
        case(
            (grams == 0, 0),
            (
                log_length.between(
                    math.log(sys.float_info.min), math.log(sys.float_info.max)
                ),
                func.exp(log_length),
            ),
        )
        if mysql
        else None
    )
    length = case(
        (
            and_(
                _usable(effective),
                _usable(Filament.diameter_mm, positive=True),
                _usable(Filament.density_g_cm3, positive=True),
            ),
            mysql_length
            if mysql
            else grams
            / func.nullif(diameter, 0)
            / func.nullif(diameter, 0)
            / func.nullif(density, 0)
            * 4
            / Decimal(str(math.pi)),
        ),
    )
    # Never emit nonfinite results or turn numerical underflow into an empty spool.
    length = case(
        (
            and_(
                _usable(length),
                or_(grams == 0, length >= _FLOAT_MIN),
            ),
            length,
        )
    )
    return {
        "remaining_percent": cast(percent, Double if mysql else Float).label(
            "remaining_percent"
        ),
        "remaining_length_m": cast(length, Double if mysql else Float).label(
            "remaining_length_m"
        ),
        "effective_remaining_weight_g": cast(
            case((_usable(effective), effective)), Double if mysql else Float
        ).label("effective_remaining_weight_g"),
    }
