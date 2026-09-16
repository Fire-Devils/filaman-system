from pydantic import BaseModel, Field


class TagScanRequest(BaseModel):
    uid: str = Field(..., min_length=1, max_length=128)
    # The same physical tag written the other way, when the reader can read
    # both. A Bambu spool carries a hardware uid on the chip and a tray uuid in
    # its payload, and a spool may be on file under either.
    alt_uid: str | None = Field(default=None, max_length=128)
    # Stable and chosen by the operator, e.g. the device hostname. A browser
    # binds to it, so it is what ties a screen to one reader. Derived from the
    # credential when omitted.
    reader_id: str | None = Field(default=None, max_length=64, pattern=r"^[A-Za-z0-9._:-]+$")
    name: str | None = Field(default=None, max_length=128)
    # What the reader thinks it read. Informational: FilaMan never decodes tag
    # contents, it only matches the uid.
    format: str | None = Field(default=None, max_length=32)


class TagScanResponse(BaseModel):
    """The lookup, so a reader that ignores the browser side still gets one."""

    uid: str
    reader_id: str
    matched_spool_id: int | None
    filament_name: str | None = None


class TagScanStateResponse(BaseModel):
    """The most recent scan, for a browser that wants to follow a reader.

    ``seq`` is milliseconds since the epoch at the moment of the scan, so it
    compares across readers without a shared counter. It is 0 when nothing has
    been scanned.
    """

    seq: int = 0
    reader_id: str | None = None
    reader_name: str | None = None
    uid: str | None = None
    spool_id: int | None = None
    spool_label: str | None = None
    timestamp: str | None = None


class TagReaderResponse(BaseModel):
    reader_id: str
    name: str | None = None
    last_seen: str | None = None
