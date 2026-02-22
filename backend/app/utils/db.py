"""Database-agnostic utility functions."""

from typing import Any

from sqlalchemy import Column, func
from sqlalchemy.dialects.sqlite import dialect as sqlite_dialect
from sqlalchemy.dialects.postgresql import dialect as postgresql_dialect
from sqlalchemy.dialects.mysql import dialect as mysql_dialect
from sqlalchemy.sql import expression


def json_extract(column: Column, path: str, dialect: Any = None) -> expression.ColumnElement:
    """
    Database-agnostic JSON extract function.
    
    Supports SQLite, PostgreSQL, and MySQL.
    
    Args:
        column: The JSON/JSONB column
        path: JSON path (e.g., '$.key')
        dialect: SQLAlchemy dialect (if None, defaults to SQLite)
    
    Returns:
        SQLAlchemy expression for JSON extraction
    """
    if dialect is None or isinstance(dialect, sqlite_dialect):
        # SQLite: json_extract(column, '$.key')
        return func.json_extract(column, path)
    elif isinstance(dialect, postgresql_dialect):
        # PostgreSQL: column->>'key' or column['key']::text
        key = path.lstrip('$.')
        return column[key].astext
    elif isinstance(dialect, mysql_dialect):
        # MySQL: JSON_EXTRACT(column, '$.key') or column->>'$.key'
        return column.op('JSON_EXTRACT')(path)
    else:
        # Fallback to SQLite behavior
        return func.json_extract(column, path)


def json_extract_cast_string(column: Column, path: str, dialect: Any = None) -> expression.ColumnElement:
    """
    Database-agnostic JSON extract cast to string.
    
    Args:
        column: The JSON/JSONB column
        path: JSON path (e.g., '$.key')
        dialect: SQLAlchemy dialect
    
    Returns:
        SQLAlchemy expression for JSON extraction cast to string
    """
    if dialect is None or isinstance(dialect, sqlite_dialect):
        # SQLite: CAST(json_extract(...) AS TEXT)
        return func.cast(func.json_extract(column, path), str)
    elif isinstance(dialect, postgresql_dialect):
        # PostgreSQL: column->>'key'
        key = path.lstrip('$.')
        return column[key].astext
    elif isinstance(dialect, mysql_dialect):
        # MySQL: CAST(JSON_EXTRACT(...) AS CHAR)
        return func.cast(column.op('JSON_EXTRACT')(path), str)
    else:
        # Fallback
        return func.cast(func.json_extract(column, path), str)
