from typing import Any, Generic, TypeVar

from pydantic import BaseModel

T = TypeVar("T")


class PaginatedResponse(BaseModel, Generic[T]):
    items: list[T]
    page: int
    page_size: int
    total: int


class ErrorResponse(BaseModel):
    error: dict[str, Any]


class MessageResponse(BaseModel):
    message: str
