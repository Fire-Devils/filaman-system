from datetime import datetime
from typing import Any

from pydantic import BaseModel


class SpoolStatusResponse(BaseModel):
    id: int
    key: str
    label: str
    description: str | None
    sort_order: int

    class Config:
        from_attributes = True


class LocationCreate(BaseModel):
    name: str
    identifier: str | None = None
    custom_fields: dict[str, Any] | None = None


class LocationUpdate(BaseModel):
    name: str | None = None
    identifier: str | None = None
    custom_fields: dict[str, Any] | None = None


class LocationResponse(BaseModel):
    id: int
    name: str
    identifier: str | None
    custom_fields: dict[str, Any] | None

    class Config:
        from_attributes = True


class SpoolCreate(BaseModel):
    filament_id: int
    status_id: int | None = None
    lot_number: str | None = None
    rfid_uid: str | None = None
    external_id: str | None = None
    location_id: int | None = None
    purchase_date: datetime | None = None
    expiration_date: datetime | None = None
    purchase_price: float | None = None
    stocked_in_at: datetime | None = None
    initial_total_weight_g: float | None = None
    empty_spool_weight_g: float | None = None
    remaining_weight_g: float | None = None
    spool_outer_diameter_mm: float | None = None
    spool_width_mm: float | None = None
    low_weight_threshold_g: int = 100
    custom_fields: dict[str, Any] | None = None


class SpoolUpdate(BaseModel):
    filament_id: int | None = None
    status_id: int | None = None
    lot_number: str | None = None
    rfid_uid: str | None = None
    external_id: str | None = None
    location_id: int | None = None
    purchase_date: datetime | None = None
    expiration_date: datetime | None = None
    purchase_price: float | None = None
    initial_total_weight_g: float | None = None
    empty_spool_weight_g: float | None = None
    spool_outer_diameter_mm: float | None = None
    spool_width_mm: float | None = None
    low_weight_threshold_g: int | None = None
    custom_fields: dict[str, Any] | None = None


class SpoolResponse(BaseModel):
    id: int
    filament_id: int
    status_id: int
    lot_number: str | None
    rfid_uid: str | None
    external_id: str | None
    location_id: int | None
    purchase_date: datetime | None
    expiration_date: datetime | None
    purchase_price: float | None
    stocked_in_at: datetime | None
    last_used_at: datetime | None
    initial_total_weight_g: float | None
    empty_spool_weight_g: float | None
    remaining_weight_g: float | None
    spool_outer_diameter_mm: float | None
    spool_width_mm: float | None
    low_weight_threshold_g: int
    deleted_at: datetime | None
    custom_fields: dict[str, Any] | None

    class Config:
        from_attributes = True


class MeasurementRequest(BaseModel):
    measured_weight_g: float
    event_at: datetime | None = None
    note: str | None = None


class AdjustmentRequest(BaseModel):
    adjustment_type: str
    delta_weight_g: float | None = None
    measured_weight_g: float | None = None
    event_at: datetime | None = None
    note: str | None = None


class ConsumptionRequest(BaseModel):
    delta_weight_g: float
    event_at: datetime | None = None
    note: str | None = None


class StatusChangeRequest(BaseModel):
    status: str
    event_at: datetime | None = None
    note: str | None = None
    meta: dict[str, Any] | None = None


class MoveLocationRequest(BaseModel):
    location_id: int | None
    event_at: datetime | None = None
    note: str | None = None


class SpoolEventResponse(BaseModel):
    id: int
    spool_id: int
    event_type: str
    event_at: datetime
    user_id: int | None
    device_id: int | None
    source: str | None
    delta_weight_g: float | None
    measured_weight_g: float | None
    from_status_id: int | None
    to_status_id: int | None
    from_location_id: int | None
    to_location_id: int | None
    note: str | None
    meta: dict[str, Any] | None

    class Config:
        from_attributes = True


class DeviceMeasurementRequest(BaseModel):
    rfid_uid: str | None = None
    external_id: str | None = None
    measured_weight_g: float
    event_at: datetime | None = None
