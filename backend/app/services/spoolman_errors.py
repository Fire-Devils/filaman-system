"""Shared exceptions for Spoolman import and repair operations."""


class SpoolmanImportError(Exception):
    """A Spoolman connection, preview, or import operation failed."""

    def __init__(self, message: str, code: str = "import_error"):
        super().__init__(message)
        self.code = code


class SpoolmanRepairError(ValueError):
    """A requested repair cannot be previewed or executed safely."""

    def __init__(self, message: str, code: str = "repair_error"):
        super().__init__(message)
        self.code = code
