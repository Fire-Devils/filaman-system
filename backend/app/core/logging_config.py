import logging
import sys
from contextvars import ContextVar

from pythonjsonlogger import jsonlogger

from app.core.config import settings

request_id_ctx: ContextVar[str | None] = ContextVar("request_id", default=None)


def get_request_id() -> str | None:
    return request_id_ctx.get()


def set_request_id(request_id: str | None) -> None:
    request_id_ctx.set(request_id)


class CustomJsonFormatter(jsonlogger.JsonFormatter):
    def add_fields(self, log_record, record, message_dict):
        super().add_fields(log_record, record, message_dict)

        log_record["timestamp"] = self.formatTime(record, self.datefmt)
        log_record["level"] = record.levelname
        log_record["logger"] = record.name

        request_id = get_request_id()
        if request_id:
            log_record["request_id"] = request_id

        if record.exc_info:
            log_record["exception"] = self.formatException(record.exc_info)


def setup_logging():
    # Use WARNING level in production (debug=false), INFO in development
    if settings.debug:
        log_level = getattr(logging, settings.log_level.upper(), logging.INFO)
    else:
        log_level = logging.WARNING

    handler = logging.StreamHandler(sys.stdout)

    if settings.log_format == "json":
        formatter = CustomJsonFormatter(
            "%(timestamp)s %(level)s %(name)s %(message)s",
            datefmt="%Y-%m-%dT%H:%M:%S%z",
        )
    else:
        formatter = logging.Formatter(
            "%(asctime)s %(levelname)s %(name)s %(message)s",
            datefmt="%Y-%m-%dT%H:%M:%S%z",
        )

    handler.setFormatter(formatter)

    root_logger = logging.getLogger()
    root_logger.setLevel(log_level)
    root_logger.handlers = [handler]

    for logger_name in ["uvicorn", "uvicorn.access"]:
        logging.getLogger(logger_name).setLevel(log_level)
    
    # SQLAlchemy: only show warnings in production, info in debug
    sqlalchemy_level = logging.INFO if settings.debug else logging.WARNING
    logging.getLogger("sqlalchemy.engine").setLevel(sqlalchemy_level)
    logging.getLogger("sqlalchemy.pool").setLevel(sqlalchemy_level)
