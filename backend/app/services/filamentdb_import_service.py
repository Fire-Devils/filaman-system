"""FilamentDB-Import-Service: Daten aus der FilamentDB importieren."""

import logging
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

import httpx
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.filament import Color, Filament, FilamentColor, Manufacturer

logger = logging.getLogger(__name__)

# Feste FilamentDB-URL (nicht konfigurierbar)
FILAMENTDB_URL = "https://db.filaman.app"

# Standard-Timeout fuer HTTP-Requests
HTTP_TIMEOUT = 30.0

# Uploads-Verzeichnis fuer Hersteller-Logos
_UPLOADS_BASE = Path("/app/data/uploads")
if not _UPLOADS_BASE.is_dir():
    from app.core.config import PROJECT_ROOT

    _UPLOADS_BASE = PROJECT_ROOT / "data" / "uploads"

LOGO_DIR = _UPLOADS_BASE / "manufacturer-logos"


class FilamentDBImportError(Exception):
    """Fehler beim FilamentDB-Import."""

    def __init__(self, message: str, code: str = "import_error"):
        super().__init__(message)
        self.code = code


@dataclass
class ImportPreview:
    """Vorschau der zu importierenden Daten."""

    manufacturers: list[dict[str, Any]] = field(default_factory=list)
    materials: list[dict[str, Any]] = field(default_factory=list)
    filaments: list[dict[str, Any]] = field(default_factory=list)
    spool_profiles: list[dict[str, Any]] = field(default_factory=list)
    colors: list[dict[str, str]] = field(default_factory=list)

    @property
    def summary(self) -> dict[str, int]:
        return {
            "manufacturers": len(self.manufacturers),
            "materials": len(self.materials),
            "filaments": len(self.filaments),
            "spool_profiles": len(self.spool_profiles),
            "colors": len(self.colors),
        }


@dataclass
class ImportResult:
    """Ergebnis des Imports."""

    manufacturers_created: int = 0
    manufacturers_skipped: int = 0
    colors_created: int = 0
    colors_skipped: int = 0
    filaments_created: int = 0
    filaments_skipped: int = 0
    logos_downloaded: int = 0
    logos_failed: int = 0
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


class FilamentDBImportService:
    """Service fuer den Import aus der FilamentDB."""

    def __init__(self, db: AsyncSession):
        self.db = db

    # ------------------------------------------------------------------ #
    #  Verbindungstest
    # ------------------------------------------------------------------ #

    async def test_connection(self) -> dict[str, Any]:
        """Verbindung zur FilamentDB testen.

        Ruft den Sync-Endpoint mit einem kuerzlichen Datum auf, um die
        Erreichbarkeit zu pruefen.
        """
        async with httpx.AsyncClient(timeout=10.0) as client:
            try:
                resp = await client.get(
                    f"{FILAMENTDB_URL}/api/v1/sync",
                    params={"since": "2099-01-01T00:00:00Z"},
                )
                if resp.status_code == 200:
                    data = resp.json()
                    return {
                        "ok": True,
                        "synced_at": data.get("synced_at"),
                    }
                raise FilamentDBImportError(
                    f"FilamentDB antwortete mit Status {resp.status_code}",
                    code="connection_failed",
                )
            except httpx.RequestError as e:
                raise FilamentDBImportError(
                    f"Verbindung zur FilamentDB fehlgeschlagen: {e}",
                    code="connection_failed",
                ) from e

    # ------------------------------------------------------------------ #
    #  Sync-Daten holen
    # ------------------------------------------------------------------ #

    async def _fetch_sync_data(self) -> dict[str, Any]:
        """Alle Daten von der FilamentDB via Sync-Endpoint laden."""
        async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:
            try:
                resp = await client.get(
                    f"{FILAMENTDB_URL}/api/v1/sync",
                    params={"since": "1970-01-01T00:00:00Z"},
                )
                resp.raise_for_status()
                return resp.json()
            except httpx.HTTPStatusError as e:
                raise FilamentDBImportError(
                    f"FilamentDB Sync fehlgeschlagen: HTTP {e.response.status_code}",
                    code="sync_failed",
                ) from e
            except httpx.RequestError as e:
                raise FilamentDBImportError(
                    f"Verbindung zur FilamentDB fehlgeschlagen: {e}",
                    code="connection_failed",
                ) from e

    # ------------------------------------------------------------------ #
    #  Farben extrahieren
    # ------------------------------------------------------------------ #

    @staticmethod
    def _extract_colors(filaments: list[dict[str, Any]]) -> list[dict[str, str]]:
        """Eindeutige Farben aus FilamentDB-Filamenten extrahieren."""
        seen: set[str] = set()
        colors: list[dict[str, str]] = []

        for fil in filaments:
            fil_colors = fil.get("colors", [])
            if not fil_colors:
                # Fallback auf top-level color_name / hex_color
                hex_code = fil.get("hex_color")
                color_name = fil.get("color_name")
                if hex_code:
                    key = hex_code.lower()
                    if key not in seen:
                        seen.add(key)
                        colors.append(
                            {
                                "name": color_name or hex_code.upper(),
                                "hex_code": hex_code,
                            }
                        )
                continue

            for c in fil_colors:
                hex_code = c.get("hex_code")
                if not hex_code:
                    continue
                key = hex_code.lower()
                if key not in seen:
                    seen.add(key)
                    colors.append(
                        {
                            "name": c.get("color_name") or hex_code.upper(),
                            "hex_code": hex_code,
                        }
                    )

        return colors

    # ------------------------------------------------------------------ #
    #  Vorschau
    # ------------------------------------------------------------------ #

    async def preview(self) -> ImportPreview:
        """Vorschau: welche Daten wuerden importiert?"""
        data = await self._fetch_sync_data()

        manufacturers = data.get("manufacturers", [])
        materials = data.get("materials", [])
        filaments = data.get("filaments", [])
        spool_profiles = data.get("spool_profiles", [])
        colors = self._extract_colors(filaments)

        return ImportPreview(
            manufacturers=manufacturers,
            materials=materials,
            filaments=filaments,
            spool_profiles=spool_profiles,
            colors=colors,
        )

    # ------------------------------------------------------------------ #
    #  Import ausfuehren
    # ------------------------------------------------------------------ #

    async def execute(
        self,
        spool_detail_target: Literal["filament", "manufacturer", "both"] = "filament",
    ) -> ImportResult:
        """Vollstaendigen Import aus der FilamentDB ausfuehren."""
        result = ImportResult()
        preview = await self.preview()

        # Material-Map: filamentdb_material_id -> material_key
        material_map: dict[int, str] = {}
        for mat in preview.materials:
            mat_id = mat.get("id")
            mat_key = mat.get("key", "").upper() or mat.get("name", "PLA").upper()
            if mat_id:
                material_map[mat_id] = mat_key

        # SpoolProfile-Map: filamentdb_spool_profile_id -> profile_data
        spool_profile_map: dict[int, dict[str, Any]] = {}
        for sp in preview.spool_profiles:
            sp_id = sp.get("id")
            if sp_id:
                spool_profile_map[sp_id] = sp

        # 1. Manufacturers importieren
        manufacturer_map = await self._import_manufacturers(
            preview.manufacturers, result
        )

        # 2. Colors importieren
        color_map = await self._import_colors(preview.colors, result)

        # 3. Filaments importieren
        await self._import_filaments(
            preview.filaments,
            material_map,
            manufacturer_map,
            color_map,
            spool_profile_map,
            spool_detail_target,
            result,
        )

        # 4. SpoolProfile auf Manufacturer-Ebene (wenn gewuenscht)
        if spool_detail_target in ("manufacturer", "both"):
            await self._apply_spool_profiles_to_manufacturers(
                preview.filaments, manufacturer_map, spool_profile_map, result
            )

        # 5. Logos herunterladen
        await self._download_manufacturer_logos(
            preview.manufacturers, manufacturer_map, result
        )

        await self.db.commit()

        logger.info(
            "FilamentDB-Import abgeschlossen: "
            "%d Hersteller, %d Filamente, %d Farben, %d Logos",
            result.manufacturers_created,
            result.filaments_created,
            result.colors_created,
            result.logos_downloaded,
        )

        return result

    # ------------------------------------------------------------------ #
    #  Manufacturers importieren
    # ------------------------------------------------------------------ #

    async def _import_manufacturers(
        self, manufacturers: list[dict[str, Any]], result: ImportResult
    ) -> dict[int, int]:
        """Manufacturers importieren. Gibt FilamentDB-ID -> FilaMan-ID."""
        mfr_map: dict[int, int] = {}

        for mfr_data in manufacturers:
            if not isinstance(mfr_data, dict):
                continue

            fdb_id = mfr_data.get("id")
            name = (mfr_data.get("name") or "").strip()
            if not name:
                continue

            # Pruefen ob Manufacturer mit gleichem Namen existiert
            existing = await self.db.execute(
                select(Manufacturer).where(
                    func.lower(Manufacturer.name) == name.lower()
                )
            )
            existing_mfr = existing.scalar_one_or_none()

            if existing_mfr:
                if fdb_id:
                    mfr_map[fdb_id] = existing_mfr.id
                result.manufacturers_skipped += 1
                continue

            new_mfr = Manufacturer(
                name=name,
                url=mfr_data.get("website"),
                custom_fields={"filamentdb_id": fdb_id} if fdb_id else None,
            )
            self.db.add(new_mfr)
            await self.db.flush()

            if fdb_id:
                mfr_map[fdb_id] = new_mfr.id
            result.manufacturers_created += 1

        return mfr_map

    # ------------------------------------------------------------------ #
    #  Colors importieren
    # ------------------------------------------------------------------ #

    async def _import_colors(
        self, colors: list[dict[str, str]], result: ImportResult
    ) -> dict[str, int]:
        """Farben importieren. Gibt hex_code (lowercase) -> FilaMan-Color-ID."""
        color_map: dict[str, int] = {}

        # Existierende Farben laden
        existing_result = await self.db.execute(select(Color))
        for color in existing_result.scalars().all():
            color_map[color.hex_code.lower()] = color.id

        for color_data in colors:
            if not isinstance(color_data, dict):
                continue

            hex_code = (color_data.get("hex_code") or "").lower()
            if not hex_code:
                continue

            if hex_code in color_map:
                result.colors_skipped += 1
                continue

            name = color_data.get("name", hex_code.upper())
            new_color = Color(
                name=name,
                hex_code=hex_code,
            )
            self.db.add(new_color)
            await self.db.flush()

            color_map[hex_code] = new_color.id
            result.colors_created += 1

        return color_map

    # ------------------------------------------------------------------ #
    #  Filaments importieren
    # ------------------------------------------------------------------ #

    async def _import_filaments(
        self,
        filaments: list[dict[str, Any]],
        material_map: dict[int, str],
        manufacturer_map: dict[int, int],
        color_map: dict[str, int],
        spool_profile_map: dict[int, dict[str, Any]],
        spool_detail_target: Literal["filament", "manufacturer", "both"],
        result: ImportResult,
    ) -> dict[int, int]:
        """Filamente importieren. Gibt FilamentDB-ID -> FilaMan-ID."""
        fil_map: dict[int, int] = {}

        for fil_data in filaments:
            if not isinstance(fil_data, dict):
                continue

            fdb_id = fil_data.get("id")

            # Manufacturer auflösen
            mfr_id_fdb = fil_data.get("manufacturer_id")
            # Versuche auch nested manufacturer
            mfr_nested = fil_data.get("manufacturer")
            if not mfr_id_fdb and isinstance(mfr_nested, dict):
                mfr_id_fdb = mfr_nested.get("id")

            filaman_mfr_id = manufacturer_map.get(mfr_id_fdb) if mfr_id_fdb else None
            if not filaman_mfr_id:
                result.warnings.append(
                    f"Filament '{fil_data.get('designation', '?')}' (FDB-ID {fdb_id}): "
                    "Kein Hersteller zugeordnet, uebersprungen"
                )
                result.filaments_skipped += 1
                continue

            # Material auflösen
            material_id_fdb = fil_data.get("material_id")
            # Nested material
            mat_nested = fil_data.get("material")
            if not material_id_fdb and isinstance(mat_nested, dict):
                material_id_fdb = mat_nested.get("id")

            material_key = material_map.get(material_id_fdb, "PLA")
            # Fallback: nested material
            if material_key == "PLA" and isinstance(mat_nested, dict):
                material_key = (
                    mat_nested.get("key") or mat_nested.get("name") or "PLA"
                ).upper()

            designation = (fil_data.get("designation") or "").strip()
            if not designation:
                designation = f"{material_key} (FilamentDB #{fdb_id})"

            # Duplicate-Check: manufacturer_id + designation + material_type
            existing = await self.db.execute(
                select(Filament).where(
                    (Filament.manufacturer_id == filaman_mfr_id)
                    & (func.lower(Filament.designation) == designation.lower())
                    & (func.lower(Filament.material_type) == material_key.lower())
                )
            )
            existing_fil = existing.scalar_one_or_none()
            if existing_fil:
                if fdb_id:
                    fil_map[fdb_id] = existing_fil.id
                result.filaments_skipped += 1
                continue

            # SpoolProfile-Daten fuer Filament-Ebene
            spool_weight_g: float | None = None
            spool_diameter: float | None = None
            spool_width: float | None = None
            spool_material: str | None = None

            if spool_detail_target in ("filament", "both"):
                sp_nested = fil_data.get("spool_profile")
                sp_id = None
                if isinstance(sp_nested, dict):
                    sp_id = sp_nested.get("id")
                elif fil_data.get("spool_profile_id"):
                    sp_id = fil_data["spool_profile_id"]

                sp_data = spool_profile_map.get(sp_id) if sp_id else None
                if sp_data:
                    spool_weight_g = sp_data.get("empty_weight_g")
                    spool_diameter = sp_data.get("outer_diameter_mm")
                    spool_width = sp_data.get("width_mm")
                    spool_material = sp_data.get("spool_material")

            # Farb-Modus
            color_mode = fil_data.get("color_mode", "single")
            multi_color_style = fil_data.get("multi_color_style")

            # Custom-Fields fuer nicht gemappte Daten
            custom: dict[str, Any] = {}
            if fdb_id:
                custom["filamentdb_id"] = fdb_id
            sku = fil_data.get("sku")
            if sku:
                custom["sku"] = sku
            # Temperatur-Daten als Custom-Fields
            for temp_key in (
                "temp_nozzle_min",
                "temp_nozzle_max",
                "temp_bed",
                "fan_speed_min",
                "fan_speed_max",
                "chamber_temp",
                "max_volumetric_speed",
                "flow_ratio",
                "k_value",
                "dry_temp",
                "dry_time_hours",
                "softening_temp",
            ):
                val = fil_data.get(temp_key)
                if val is not None:
                    custom[temp_key] = val

            new_fil = Filament(
                manufacturer_id=filaman_mfr_id,
                designation=designation,
                material_type=material_key,
                material_subgroup=fil_data.get("material_subtype"),
                diameter_mm=fil_data.get("diameter_mm", 1.75) or 1.75,
                manufacturer_color_name=fil_data.get("color_name"),
                raw_material_weight_g=fil_data.get("nominal_weight_g"),
                default_spool_weight_g=spool_weight_g,
                spool_outer_diameter_mm=spool_diameter,
                spool_width_mm=spool_width,
                spool_material=spool_material,
                price=fil_data.get("price"),
                shop_url=fil_data.get("shop_url"),
                density_g_cm3=fil_data.get("density_g_cm3"),
                color_mode=color_mode,
                multi_color_style=multi_color_style,
                custom_fields=custom if custom else None,
            )
            self.db.add(new_fil)
            await self.db.flush()

            if fdb_id:
                fil_map[fdb_id] = new_fil.id

            # FilamentColor-Zuordnungen
            await self._create_filament_colors(new_fil.id, fil_data, color_map)

            result.filaments_created += 1

        return fil_map

    # ------------------------------------------------------------------ #
    #  FilamentColor-Zuordnungen erstellen
    # ------------------------------------------------------------------ #

    async def _create_filament_colors(
        self,
        filament_id: int,
        fil_data: dict[str, Any],
        color_map: dict[str, int],
    ) -> None:
        """Farb-Zuordnungen fuer ein Filament erstellen."""
        fil_colors = fil_data.get("colors", [])

        if not fil_colors:
            # Fallback: top-level hex_color
            hex_code = fil_data.get("hex_color")
            if hex_code:
                color_id = color_map.get(hex_code.lower())
                if color_id:
                    fc = FilamentColor(
                        filament_id=filament_id,
                        color_id=color_id,
                        position=1,
                    )
                    self.db.add(fc)
            return

        for c in fil_colors:
            hex_code = c.get("hex_code")
            if not hex_code:
                continue
            color_id = color_map.get(hex_code.lower())
            if not color_id:
                continue
            position = c.get("position", 1)
            display_name = c.get("color_name")

            fc = FilamentColor(
                filament_id=filament_id,
                color_id=color_id,
                position=position,
                display_name_override=display_name,
            )
            self.db.add(fc)

    # ------------------------------------------------------------------ #
    #  SpoolProfile auf Manufacturer-Ebene anwenden
    # ------------------------------------------------------------------ #

    async def _apply_spool_profiles_to_manufacturers(
        self,
        filaments: list[dict[str, Any]],
        manufacturer_map: dict[int, int],
        spool_profile_map: dict[int, dict[str, Any]],
        result: ImportResult,
    ) -> None:
        """SpoolProfile-Daten auf Manufacturer-Ebene uebertragen.

        Verwendet das haeufigste SpoolProfile pro Manufacturer.
        """
        # Sammle SpoolProfile-IDs pro Manufacturer
        mfr_profiles: dict[int, list[int]] = {}
        for fil in filaments:
            mfr_id_fdb = fil.get("manufacturer_id")
            sp_nested = fil.get("spool_profile")
            sp_id = None
            if isinstance(sp_nested, dict):
                sp_id = sp_nested.get("id")
            elif fil.get("spool_profile_id"):
                sp_id = fil["spool_profile_id"]

            if mfr_id_fdb and sp_id:
                mfr_profiles.setdefault(mfr_id_fdb, []).append(sp_id)

        for fdb_mfr_id, sp_ids in mfr_profiles.items():
            filaman_mfr_id = manufacturer_map.get(fdb_mfr_id)
            if not filaman_mfr_id:
                continue

            # Haeufigstes SpoolProfile
            most_common_sp_id = Counter(sp_ids).most_common(1)[0][0]
            sp_data = spool_profile_map.get(most_common_sp_id)
            if not sp_data:
                continue

            # Manufacturer updaten
            mfr_result = await self.db.execute(
                select(Manufacturer).where(Manufacturer.id == filaman_mfr_id)
            )
            mfr = mfr_result.scalar_one_or_none()
            if not mfr:
                continue

            # Nur ueberschreiben wenn noch nicht gesetzt
            if mfr.empty_spool_weight_g is None and sp_data.get("empty_weight_g"):
                mfr.empty_spool_weight_g = sp_data["empty_weight_g"]
            if mfr.spool_outer_diameter_mm is None and sp_data.get("outer_diameter_mm"):
                mfr.spool_outer_diameter_mm = sp_data["outer_diameter_mm"]
            if mfr.spool_width_mm is None and sp_data.get("width_mm"):
                mfr.spool_width_mm = sp_data["width_mm"]
            if mfr.spool_material is None and sp_data.get("spool_material"):
                mfr.spool_material = sp_data["spool_material"]

    # ------------------------------------------------------------------ #
    #  Logos herunterladen
    # ------------------------------------------------------------------ #

    async def _download_manufacturer_logos(
        self,
        manufacturers: list[dict[str, Any]],
        manufacturer_map: dict[int, int],
        result: ImportResult,
    ) -> None:
        """Hersteller-Logos von der FilamentDB herunterladen."""
        LOGO_DIR.mkdir(parents=True, exist_ok=True)

        async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:
            for mfr_data in manufacturers:
                if not isinstance(mfr_data, dict):
                    continue

                fdb_id = mfr_data.get("id")
                slug = mfr_data.get("slug")
                has_logo = mfr_data.get("has_web_logo", False)

                if not has_logo or not slug:
                    continue

                filaman_mfr_id = manufacturer_map.get(fdb_id)
                if not filaman_mfr_id:
                    continue

                logo_filename = f"{filaman_mfr_id}.png"
                logo_path = LOGO_DIR / logo_filename

                # Skip wenn schon vorhanden
                if logo_path.exists():
                    continue

                logo_url = f"{FILAMENTDB_URL}/uploads/logos/web/{slug}.png"
                try:
                    resp = await client.get(logo_url)
                    if resp.status_code == 200:
                        logo_path.write_bytes(resp.content)

                        # DB updaten
                        mfr_result = await self.db.execute(
                            select(Manufacturer).where(
                                Manufacturer.id == filaman_mfr_id
                            )
                        )
                        mfr = mfr_result.scalar_one_or_none()
                        if mfr:
                            mfr.logo_file = logo_filename
                        result.logos_downloaded += 1
                    else:
                        result.logos_failed += 1
                        result.warnings.append(
                            f"Logo fuer '{mfr_data.get('name', '?')}' nicht verfuegbar "
                            f"(HTTP {resp.status_code})"
                        )
                except httpx.RequestError as e:
                    result.logos_failed += 1
                    result.warnings.append(
                        f"Logo-Download fuer '{mfr_data.get('name', '?')}' "
                        f"fehlgeschlagen: {e}"
                    )
