from pydantic import BaseModel, Field


class SystemExtraFieldBase(BaseModel):
    target_type: str = Field(..., description="'filament' or 'spool'")
    key: str = Field(..., description="Key for the JSON custom_fields")
    label: str = Field(..., description="Display label")
    default_value: str | None = Field(None, description="Default value if any")


class SystemExtraFieldCreate(SystemExtraFieldBase):
    pass


class SystemExtraFieldResponse(SystemExtraFieldBase):
    id: int

    class Config:
        from_attributes = True
