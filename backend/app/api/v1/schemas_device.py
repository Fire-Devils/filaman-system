from typing import Literal

from pydantic import BaseModel, Field, IPvAnyAddress


class WeighRequest(BaseModel):
    spool_id: int | None = None
    tag_uuid: str | None = None
    measured_weight_g: float = Field(..., gt=0)


class WeighResponse(BaseModel):
    remaining_weight_g: float
    spool_id: int
    filament_name: str | None


class SpoolFullRequest(BaseModel):
    spool_id: int | None = None
    tag_uuid: str | None = None
    measured_weight_g: float = Field(..., gt=0)
    confirm_overwrite: bool = False


class SpoolFullResponse(BaseModel):
    spool_id: int
    old_tara_g: float | None
    new_tara_g: float
    remaining_weight_g: float
    filament_name: str | None


class LocateRequest(BaseModel):
    spool_id: int | None = None
    spool_tag_uuid: str | None = None
    location_id: int | None = None
    location_tag_uuid: str | None = None


class LocateResponse(BaseModel):
    success: bool
    spool_id: int
    location_id: int | None
    location_name: str | None


class HeartbeatRequest(BaseModel):
    ip_address: IPvAnyAddress
    firmware_version: str | None = Field(default=None, max_length=32)
    firmware_project: str | None = Field(default=None, max_length=64)


class OtaReportRequest(BaseModel):
    from_version: str = Field(max_length=32)
    to_version: str = Field(max_length=32)
    result: Literal["started", "ok", "failed", "rolled_back"]
    error: str | None = None


class WriteTagRequest(BaseModel):
    spool_id: int | None = None
    location_id: int | None = None
    # Which of the spool's two RFID slots the written chip should take when
    # both are already filled (1 or 2). Default: the second slot.
    replace_slot: int | None = Field(default=None, ge=1, le=2)


class WriteTagResponse(BaseModel):
    success: bool
    message: str
    tag_uuid: str | None = None


class RfidResultRequest(BaseModel):
    success: bool
    tag_uuid: str | None = None
    error_message: str | None = None
    spool_id: int | None = None
    location_id: int | None = None
    remaining_weight_g: float | None = None


class RfidResultResponse(BaseModel):
    status: str
    message: str


class WriteStatusResponse(BaseModel):
    status: str  # "pending", "success", "error"
    tag_uuid: str | None = None
    removed_from: str | None = None
    error_message: str | None = None
    timestamp: str | None = None


class TagDataRequest(BaseModel):
    tag_json: str  # Raw JSON string from the NFC tag


class TagScanStatusResponse(BaseModel):
    status: str  # "none", "pending", "success", "error"
    tag_data: dict | None = None
    error_message: str | None = None
    timestamp: str | None = None
