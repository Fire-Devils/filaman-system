"""Plausibilitätsbereiche für Druckprofile (filament_printer_profiles).

Die Bereiche entsprechen dem Vertrag mit der FilaMan-DB und werden auch beim
Einreichen von Profilen wiederverwendet. Grenzen sind inklusive, ``None`` ist
immer erlaubt.
"""

from typing import Any

# Feldname -> (min, max)
PRINT_PROFILE_RANGES: dict[str, tuple[float, float]] = {
    "nozzle_diameter_mm": (0.1, 2.0),
    "nozzle_temp_c": (150, 500),
    "bed_temp_c": (0, 150),
    "chamber_temp_c": (0, 100),
    "print_speed_mm_s": (1, 1500),
    "travel_speed_mm_s": (1, 1500),
    "first_layer_speed_mm_s": (1, 1500),
    "retraction_speed_mm_s": (1, 1500),
    "deretraction_speed_mm_s": (1, 1500),
    "max_volumetric_flow_mm3_s": (0.5, 100),
    "flowrate_percent": (50, 150),
    "extrusion_multiplier": (0.5, 1.5),
    "pressure_advance_k": (0, 2),
    "linear_advance_k": (0, 200),
    "retraction_mm": (0, 15),
    "retraction_extra_prime_mm3": (0, 10),
    "fan_percent_min": (0, 100),
    "fan_percent_max": (0, 100),
    "fan_first_layer_percent": (0, 100),
    "bridge_fan_percent": (0, 100),
    "bridge_flow_percent": (50, 150),
    "z_hop_mm": (0, 5),
}


def find_implausible_values(data: dict[str, Any]) -> list[dict[str, Any]]:
    """Liefert je unplausiblem Feld ``{field, min, max}``; leer, wenn alles passt."""
    problems: list[dict[str, Any]] = []
    for field, (low, high) in PRINT_PROFILE_RANGES.items():
        value = data.get(field)
        if value is None or isinstance(value, bool):
            continue
        if not low <= value <= high:
            problems.append({"field": field, "min": low, "max": high})
    return problems
