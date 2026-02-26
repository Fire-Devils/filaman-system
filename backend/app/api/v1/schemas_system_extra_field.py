from pydantic import BaseModel, Field


class SystemExtraFieldBase(BaseModel):
    target_type: str = Field(..., description="'filament' or 'spool'")
    key: str = Field(..., description="Key for the JSON custom_fields")
    label: str = Field(..., description="Display label")
    default_value: str | None = Field(None, description="Default value if any")
    field_type: str = Field("text", description="Field type: text, number, dropdown, checkbox")
    options: list[str] | None = Field(None, description="Options for dropdown fields")


class SystemExtraFieldCreate(SystemExtraFieldBase):
    source: str | None = Field(None, description="Plugin source, e.g. 'bambulab'. Protected from manual deletion.")


class SystemExtraFieldResponse(SystemExtraFieldBase):
    id: int
    source: str | None = None

    class Config:
        from_attributes = True
