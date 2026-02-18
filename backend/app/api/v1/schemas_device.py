from pydantic import BaseModel, Field


class WeighRequest(BaseModel):
    spool_id: int | None = None
    tag_uuid: str | None = None
    measured_weight_g: float = Field(..., gt=0)


class WeighResponse(BaseModel):
    remaining_weight_g: float
    spool_id: int
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
    ip_address: str
