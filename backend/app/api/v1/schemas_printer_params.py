from pydantic import BaseModel, Field


class PrinterParamBase(BaseModel):
    param_key: str = Field(..., description="Parameter key, e.g. 'bambu_k', 'bambu_flow_ratio'")
    param_value: str | None = Field(None, description="Parameter value as string")


class PrinterParamCreate(PrinterParamBase):
    pass


class PrinterParamUpdate(BaseModel):
    param_value: str | None = Field(None, description="New parameter value")


class PrinterParamBulkItem(PrinterParamBase):
    """Single item for bulk upsert."""
    pass


class PrinterParamBulkRequest(BaseModel):
    """Bulk upsert: set multiple params at once for a filament/spool + printer combination."""
    params: list[PrinterParamBulkItem]


class FilamentPrinterParamResponse(PrinterParamBase):
    id: int
    filament_id: int
    printer_id: int

    class Config:
        from_attributes = True


class SpoolPrinterParamResponse(PrinterParamBase):
    id: int
    spool_id: int
    printer_id: int

    class Config:
        from_attributes = True
