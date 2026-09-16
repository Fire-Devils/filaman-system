from datetime import datetime

from sqlalchemy import BigInteger, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TZDateTime


class TagReader(Base):
    """A device or app that reports scanned tags, and the last tag it read.

    One row per reader, overwritten on every scan. A scan is a moment, not a
    record: nothing here is history, and the row exists so that any Gunicorn
    worker can answer "what was just scanned" - the database is the only thing
    all of them can see.

    Deliberately not tied to the device registry. A reader may be a registered
    scale, an app signed in with an API key, or anything else that can hold a
    credential, and none of those should have to become a device row first.
    """

    __tablename__ = "tag_readers"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    # Chosen by the reader and stable across its restarts, because a browser
    # binds to it. Derived from the credential when a reader sends none.
    reader_id: Mapped[str] = mapped_column(String(64), unique=True, nullable=False, index=True)
    name: Mapped[str | None] = mapped_column(String(128), nullable=True)

    # Milliseconds since the epoch at the moment of the scan. Comparable across
    # readers without anyone keeping a counter, which is what lets a browser
    # tell a new scan from one it has already acted on.
    last_seq: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    last_uid: Mapped[str | None] = mapped_column(String(128), nullable=True)
    # No foreign key: this records what a reader saw, not a relation between
    # two rows. Deleting the spool must not delete the fact that it was read.
    last_spool_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # So an offer can name the spool without a second request.
    last_spool_label: Mapped[str | None] = mapped_column(String(255), nullable=True)
    last_seen_at: Mapped[datetime | None] = mapped_column(TZDateTime(), nullable=True)
