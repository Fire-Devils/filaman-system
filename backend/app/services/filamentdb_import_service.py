"""FilamentDB-Import-Service: Daten aus der FilamentDB importieren."""

import asyncio
import copy
import hashlib
import logging
import os
import tempfile
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from typing import Any, ClassVar, Literal
from uuid import uuid4

import httpx
from sqlalchemy import String, cast, delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.cache import response_cache
from app.models.filament import Color, Filament, FilamentColor, Manufacturer
from app.services.bambu_idx import clear_bambu_idx_for_filament
from app.services.filamentdb_contribution_service import mark_in_sync
from app.services.extra_field_validation import normalize_numeric_range
from app.services.filamentdb_field_mapping import standard_filamentdb_fields
from app.services.material_presets import apply_defaults_to_new_filament
from app.services.spoolman_projection import catalog_promotion_aliases
from app.utils.search import FUZZY_MATCH_THRESHOLD, fuzzy_token_score

logger = logging.getLogger(__name__)

# Feste FilamentDB-URL (nicht konfigurierbar)
FILAMENTDB_URL = "https://db.filaman.app"

# Standard-Timeout fuer HTTP-Requests
HTTP_TIMEOUT = 30.0

# Sync-Snapshot-Cache: ein einziger Slot, wird bei jedem neuen Preview ersetzt.
# Verhindert wiederholte HTTP-Requests innerhalb eines mehrstufigen Import-Flows.
SYNC_CACHE_KEY = "filamentdb_import:sync_snapshot"
SYNC_CACHE_TTL_SECONDS = 300

# Uploads-Verzeichnis fuer Hersteller-Logos (persistenter Pfad)
from app.core.config import MANUFACTURER_LOGO_DIR as LOGO_DIR

LOGO_MAX_BYTES = 2 * 1024 * 1024
LOGO_PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
LOGO_CONCURRENCY = 5

# Schwellwert fuer Fuzzy-Matching (75%)
FUZZY_THRESHOLD = FUZZY_MATCH_THRESHOLD


def _material_type_from_fdb(mat: dict[str, Any]) -> str:
    """material_type aus einem FilamentDB-Material: Anzeigename (z.B. "PLA+/Pro"),
    nicht der Slug ("pla-plus")."""
    name = (mat.get("name") or "").strip()
    if name:
        return name
    return (mat.get("key") or "").upper() or "PLA"


def _material_type_aliases(name: str, legacy_key: str | None) -> tuple[str, ...]:
    return tuple(dict.fromkeys(value.strip().lower() for value in (name, legacy_key) if value and value.strip()))


def _resolve_mfr_id(fil: dict[str, Any]) -> int | None:
    """FilamentDB-Manufacturer-ID aus einem Filament-Dict auflösen."""
    mfr_id = fil.get("manufacturer_id")
    if mfr_id:
        return mfr_id
    mfr_nested = fil.get("manufacturer")
    if isinstance(mfr_nested, dict):
        return mfr_nested.get("id")
    return None


def _resolve_spool_profile(data: dict[str, Any], profiles: dict[int, dict[str, Any]]) -> dict[str, Any] | None:
    nested = data.get('spool_profile')
    profile_id = nested.get('id') if isinstance(nested, dict) else data.get('spool_profile_id')
    profile = profiles.get(profile_id) if isinstance(profile_id, int) else None
    return profile if profile is not None else nested if isinstance(nested, dict) else None


def _fdb_match_keys(
    fdb_f: dict[str, Any],
    fdb_mfr_map: dict[int, str],
    mat_map: dict[int, str],
    mat_legacy_map: dict[int, str],
) -> tuple[str, str, tuple[str, ...]]:
    """Abgleich-Schluessel eines FDB-Filaments: (Hersteller lower, Bezeichnung lower, Materialien)."""
    mfr_id_fdb = _resolve_mfr_id(fdb_f)
    mfr_name = fdb_mfr_map.get(mfr_id_fdb, "").lower() if mfr_id_fdb else ""
    designation = (fdb_f.get("designation") or "").lower()
    mat_id = fdb_f.get("material_id")
    mat_nested = fdb_f.get("material")
    if not mat_id and isinstance(mat_nested, dict):
        mat_id = mat_nested.get("id")
    material = mat_map.get(mat_id, "PLA").lower()
    if material == "pla" and isinstance(mat_nested, dict):
        material = _material_type_from_fdb(mat_nested).lower()
    # Aeltere Importe speicherten den Key (z.B. PLA-PLUS) statt des Namens
    legacy = mat_legacy_map.get(mat_id)
    if legacy is None and isinstance(mat_nested, dict):
        legacy = mat_nested.get("key")
    return mfr_name, designation, _material_type_aliases(material, legacy)


def _best_fuzzy(designation: str, candidates: list[tuple[str, Any]]) -> tuple[Any, float]:
    """Bester Fuzzy-Treffer (Bezeichnung, Objekt) -> (Objekt, Score); erster Maximalwert gewinnt."""
    best_score = 0.0
    best: Any = None
    for cand_desig, obj in candidates:
        score = fuzzy_token_score(cand_desig, designation)
        if score > best_score:
            best_score = score
            best = obj
    return best, best_score


class FilamentDBImportError(Exception):
    """Fehler beim FilamentDB-Import."""

    def __init__(self, message: str, code: str = "import_error"):
        super().__init__(message)
        self.code = code


@dataclass
class ImportPreview:
    """Vorschau der zu importierenden Daten."""

    snapshot_id: str | None = None
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
class ManufacturerPreview:
    """Leichtgewichtige Vorschau — nur Hersteller + Materialien (keine Filamente)."""

    snapshot_id: str | None = None
    manufacturers: list[dict[str, Any]] = field(default_factory=list)
    materials: list[dict[str, Any]] = field(default_factory=list)
    total_filaments: int = 0

    @property
    def summary(self) -> dict[str, int]:
        return {
            "manufacturers": len(self.manufacturers),
            "materials": len(self.materials),
            "filaments": self.total_filaments,
        }


@dataclass
class FilamentsByManufacturer:
    """Filamente + Farben fuer ausgewaehlte Hersteller."""

    snapshot_id: str | None = None
    filaments: list[dict[str, Any]] = field(default_factory=list)
    colors: list[dict[str, str]] = field(default_factory=list)


@dataclass
class SyncSnapshot:
    """Kurzlebige, wiederverwendbare Momentaufnahme des FilamentDB Sync-Endpoints."""

    snapshot_id: str
    synced_at: str | None
    data: dict[str, Any]


@dataclass
class DiffResult:
    """Ergebnis eines Filament-Diffs inkl. resolved Snapshot-ID."""

    snapshot_id: str | None = None
    results: list[dict[str, Any]] = field(default_factory=list)


@dataclass
class ImportResult:
    """Ergebnis des Imports."""

    manufacturers_created: int = 0
    manufacturers_skipped: int = 0
    colors_created: int = 0
    colors_skipped: int = 0
    filaments_created: int = 0
    filaments_skipped: int = 0
    filaments_updated: int = 0
    manufacturers_updated: int = 0
    logos_downloaded: int = 0
    logos_failed: int = 0
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


def _temperature_ranges(
    data: dict[str, Any],
) -> tuple[dict[str, dict[str, int | float | None]], set[str]]:
    ranges: dict[str, dict[str, int | float | None]] = {}
    migrated: set[str] = set()
    nozzle = {
        "min": data.get("temp_nozzle_min"),
        "max": data.get("temp_nozzle_max"),
    }
    if nozzle != {"min": None, "max": None}:
        try:
            ranges["extruder_temp_range_c"] = normalize_numeric_range(nozzle)
        except ValueError:
            pass
        else:
            migrated.update(
                key
                for key in ("temp_nozzle_min", "temp_nozzle_max")
                if data.get(key) is not None
            )
    if data.get("temp_bed") is not None:
        try:
            ranges["bed_temp_range_c"] = normalize_numeric_range(data["temp_bed"])
        except ValueError:
            pass
        else:
            migrated.add("temp_bed")
    return ranges, migrated


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

    async def _fetch_sync_data(
        self,
        snapshot_id: str | None = None,
        *,
        force_refresh: bool = False,
    ) -> SyncSnapshot:
        """Sync-Daten von der FilamentDB laden oder aus dem Cache holen.

        Die Import-UI arbeitet in mehreren Schritten (Preview, Filament-Auswahl,
        Diff, Execute). Ohne Snapshot-Reuse wurde bei jedem Schritt die komplette
        Sync-Antwort erneut von FilamentDB geladen, was die UI bei grossen
        Datenmengen deutlich verlangsamt hat.

        Es gibt genau **einen** Cache-Slot (``SYNC_CACHE_KEY``).  Ein neuer
        Preview ersetzt den alten Snapshot; nachfolgende Schritte lesen ihn.
        Shared data is read-only internally; consumers copy returned or annotated rows.
        """
        # -- Versuch aus Cache zu lesen (sofern kein force_refresh) --
        if not force_refresh:
            cached = response_cache.get(SYNC_CACHE_KEY)
            if isinstance(cached, dict) and isinstance(cached.get("data"), dict):
                cached_id = cached.get("snapshot_id", "")
                # Treffer wenn keine bestimmte ID verlangt oder die ID stimmt
                if not snapshot_id or snapshot_id == cached_id:
                    return SyncSnapshot(
                        snapshot_id=cached_id,
                        synced_at=cached.get("synced_at"),
                        data=cached["data"],
                    )

        # -- Cache-Miss oder force_refresh: frisch von FilamentDB laden --
        async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:
            try:
                resp = await client.get(
                    f"{FILAMENTDB_URL}/api/v1/sync",
                    params={"since": "1970-01-01T00:00:00Z"},
                )
                resp.raise_for_status()
                payload = resp.json()
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

        new_id = uuid4().hex
        response_cache.set(
            SYNC_CACHE_KEY,
            {
                "snapshot_id": new_id,
                "synced_at": payload.get("synced_at"),
                "data": payload,
            },
            ttl=SYNC_CACHE_TTL_SECONDS,
        )

        return SyncSnapshot(
            snapshot_id=new_id,
            synced_at=payload.get("synced_at"),
            data=payload,
        )

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
    #  Leichtgewichtige Vorschau (nur Hersteller + Materialien)
    # ------------------------------------------------------------------ #

    async def preview_manufacturers(
        self,
        snapshot_id: str | None = None,
        *,
        force_refresh: bool = False,
    ) -> ManufacturerPreview:
        """Vorschau: nur Hersteller und Materialien zurueckgeben.

        Filamente werden intern gelesen (fuer ``_filament_count`` und
        ``_material_types``), aber NICHT an den Caller zurueckgegeben.
        Das spart bei 40k+ Filamenten enorm Bandbreite.
        """
        snapshot = await self._fetch_sync_data(
            snapshot_id=snapshot_id,
            force_refresh=force_refresh,
        )
        data = snapshot.data

        manufacturers = copy.deepcopy(data.get("manufacturers", []))
        materials = data.get("materials", [])
        filaments = data.get("filaments", [])

        # -- Duplikat-Abgleich: Manufacturers --
        existing_mfr_result = await self.db.execute(select(Manufacturer))
        existing_mfr_names: set[str] = {
            (m.name or "").lower() for m in existing_mfr_result.scalars().all()
        }

        for mfr in manufacturers:
            name = (mfr.get("name") or "").strip().lower()
            mfr["_exists"] = name in existing_mfr_names

        # -- Material-Map fuer Filament-Zaehlung --
        mat_map: dict[int, str] = {}
        for mat in materials:
            mid = mat.get("id")
            mkey = _material_type_from_fdb(mat)
            if mid:
                mat_map[mid] = mkey

        # Filament-Zaehler und Materialtypen pro Manufacturer
        mfr_filament_counts: dict[int, int] = {}
        mfr_material_types: dict[int, set[str]] = {}

        for fil in filaments:
            mfr_id_fdb = _resolve_mfr_id(fil)

            # Material auflösen
            mat_id_fdb = fil.get("material_id")
            mat_nested = fil.get("material")
            if not mat_id_fdb and isinstance(mat_nested, dict):
                mat_id_fdb = mat_nested.get("id")

            material_key = mat_map.get(mat_id_fdb, "PLA")
            if material_key == "PLA" and isinstance(mat_nested, dict):
                material_key = _material_type_from_fdb(mat_nested)

            if mfr_id_fdb:
                mfr_filament_counts[mfr_id_fdb] = (
                    mfr_filament_counts.get(mfr_id_fdb, 0) + 1
                )
                mfr_material_types.setdefault(mfr_id_fdb, set()).add(material_key)

        # Manufacturers anreichern
        for mfr in manufacturers:
            fdb_id = mfr.get("id")
            mfr["_filament_count"] = mfr_filament_counts.get(fdb_id, 0)
            mfr["_material_types"] = sorted(mfr_material_types.get(fdb_id, set()))

        return ManufacturerPreview(
            snapshot_id=snapshot.snapshot_id,
            manufacturers=manufacturers,
            materials=copy.deepcopy(materials),
            total_filaments=len(filaments),
        )

    # ------------------------------------------------------------------ #
    #  Filamente fuer ausgewaehlte Hersteller
    # ------------------------------------------------------------------ #

    async def fetch_filaments(
        self,
        manufacturer_ids: list[int],
        snapshot_id: str | None = None,
    ) -> FilamentsByManufacturer:
        """Filamente + Farben fuer die gegebenen Hersteller-IDs laden.

        Filtert die FilamentDB-Daten auf die uebergebenen Manufacturer-IDs
        und reichert jedes Filament mit ``_exists`` und ``_material_key`` an.
        """
        snapshot = await self._fetch_sync_data(snapshot_id=snapshot_id)
        data = snapshot.data

        manufacturers = data.get("manufacturers", [])
        materials = data.get("materials", [])
        all_filaments = data.get("filaments", [])

        mfr_id_set = set(manufacturer_ids)

        # Material-Map
        mat_map: dict[int, str] = {}
        for mat in materials:
            mid = mat.get("id")
            mkey = _material_type_from_fdb(mat)
            if mid:
                mat_map[mid] = mkey

        mat_legacy_map = {mat.get("id"): mat.get("key") for mat in materials}

        # FDB-Manufacturer-ID -> Name (fuer Filament-Duplikat-Check)
        fdb_mfr_id_to_name: dict[int, str] = {}
        for mfr in manufacturers:
            fdb_id = mfr.get("id")
            if fdb_id:
                fdb_mfr_id_to_name[fdb_id] = (mfr.get("name") or "").strip()

        # Duplikat-Abgleich: Filaments (exakt + fuzzy)
        existing_fil_result = await self.db.execute(
            select(
                Filament.designation,
                Filament.material_type,
                Manufacturer.name,
                Filament.custom_fields["filamentdb_id"].as_string(),
            ).join(Manufacturer, Filament.manufacturer_id == Manufacturer.id).order_by(Filament.id)
        )
        existing_rows = existing_fil_result.all()
        existing_catalog_ids = {
            ((row[2] or "").lower(), str(row[3])) for row in existing_rows if row[3] is not None
        }
        existing_fil_keys: set[tuple[str, str, str]] = set()
        # Index fuer Fuzzy-Lookup: (mfr_name_lower, material_lower) -> [designation, ...]
        existing_by_mfr_mat: dict[tuple[str, str], list[str]] = defaultdict(list)
        for row in existing_rows:
            # A saved identity must never be reassigned by name/material matching.
            if row[3] not in (None, ""):
                continue
            mfr = (row[2] or "").lower()
            desig = (row[0] or "").lower()
            mat = (row[1] or "").lower()
            existing_fil_keys.add((mfr, desig, mat))
            existing_by_mfr_mat[(mfr, mat)].append(row[0] or "")

        # Filamente filtern und anreichern
        filtered_filaments: list[dict[str, Any]] = []
        for fil in all_filaments:
            mfr_id_fdb = _resolve_mfr_id(fil)
            if not mfr_id_fdb or mfr_id_fdb not in mfr_id_set:
                continue

            fil = copy.deepcopy(fil)

            # Material auflösen
            mat_id_fdb = fil.get("material_id")
            mat_nested = fil.get("material")
            if not mat_id_fdb and isinstance(mat_nested, dict):
                mat_id_fdb = mat_nested.get("id")

            material_key = mat_map.get(mat_id_fdb, "PLA")
            if material_key == "PLA" and isinstance(mat_nested, dict):
                material_key = _material_type_from_fdb(mat_nested)

            fil["_material_key"] = material_key
            legacy_key = mat_legacy_map.get(mat_id_fdb)
            if legacy_key is None and isinstance(mat_nested, dict):
                legacy_key = mat_nested.get("key")
            material_keys = _material_type_aliases(material_key, legacy_key)

            # Duplikat-Check: exakt, dann fuzzy
            designation = (fil.get("designation") or "").strip()
            mfr_name = fdb_mfr_id_to_name.get(mfr_id_fdb, "")
            known = (mfr_name.lower(), str(fil.get("id"))) in existing_catalog_ids
            known = known or any(
                (mfr_name.lower(), designation.lower(), material) in existing_fil_keys
                for material in material_keys
            )

            if known:
                fil["_exists"] = True
                fil["_match_type"] = "exact"
            else:
                # Fuzzy-Fallback: alle lokalen Filamente desselben Herstellers+Materials
                candidates = [
                    name for material in material_keys
                    for name in existing_by_mfr_mat.get((mfr_name.lower(), material), [])
                ]
                best_score = 0.0
                best_name: str | None = None
                for local_desig in candidates:
                    score = fuzzy_token_score(local_desig, designation)
                    if score > best_score:
                        best_score = score
                        best_name = local_desig

                if best_score >= FUZZY_THRESHOLD and best_name is not None:
                    fil["_exists"] = True
                    fil["_match_type"] = "fuzzy"
                    fil["_matched_name"] = best_name
                    fil["_match_score"] = round(best_score, 2)
                else:
                    fil["_exists"] = False

            filtered_filaments.append(fil)

        colors = self._extract_colors(filtered_filaments)

        return FilamentsByManufacturer(
            snapshot_id=snapshot.snapshot_id,
            filaments=filtered_filaments,
            colors=colors,
        )

    # ------------------------------------------------------------------ #
    #  Diff: existierende Filamente mit FDB-Daten vergleichen
    # ------------------------------------------------------------------ #

    # Felder, die verglichen werden (FDB-Feld -> FilaMan-Feld)
    _DIFF_FIELDS: ClassVar[list[tuple[str, str, str]]] = [
        # (fdb_key, filaman_attr, label)
        ("designation", "designation", "designation"),
        ("material_subtype", "material_subgroup", "material_subgroup"),
        ("diameter_mm", "diameter_mm", "diameter_mm"),
        ("color_name", "manufacturer_color_name", "manufacturer_color_name"),
        ("nominal_weight_g", "raw_material_weight_g", "raw_material_weight_g"),
        ("price", "price", "price"),
        ("shop_url", "shop_url", "shop_url"),
        ("density_g_cm3", "density_g_cm3", "density_g_cm3"),
        ("color_mode", "color_mode", "color_mode"),
    ]

    async def diff_filaments(
        self,
        filament_ids: list[int],
        snapshot_id: str | None = None,
    ) -> DiffResult:
        """Vergleiche existierende FilaMan-Filamente mit FDB-Daten.

        Args:
            filament_ids: FDB-IDs der zu vergleichenden Filamente.
            snapshot_id: Optionale Snapshot-ID fuer Cache-Reuse.

        Returns:
            DiffResult mit der resolved Snapshot-ID und der Diff-Liste.
        """
        if not filament_ids:
            return DiffResult(snapshot_id=snapshot_id, results=[])

        snapshot = await self._fetch_sync_data(snapshot_id=snapshot_id)
        data = snapshot.data
        all_filaments = data.get("filaments", [])
        manufacturers = data.get("manufacturers", [])
        materials = data.get("materials", [])
        spool_profiles = data.get("spool_profiles", [])

        # Maps aufbauen
        fdb_mfr_map: dict[int, str] = {
            m["id"]: (m.get("name") or "").strip() for m in manufacturers if m.get("id")
        }
        mat_map: dict[int, str] = {}
        mat_legacy_map: dict[int, str] = {}
        for mat in materials:
            mid = mat.get("id")
            mkey = _material_type_from_fdb(mat)
            if mid:
                mat_map[mid] = mkey
                mat_legacy_map[mid] = (mat.get("key") or "").lower()

        sp_map: dict[int, dict[str, Any]] = {}
        for sp in spool_profiles:
            sp_id = sp.get("id")
            if sp_id:
                sp_map[sp_id] = sp

        # FDB-Filamente indexieren
        id_set = set(filament_ids)
        requested_ids = {str(fid): fid for fid in id_set}
        fdb_fils: dict[int, dict[str, Any]] = {}
        for f in all_filaments:
            fdb_id = f.get("id")
            if fdb_id and fdb_id in id_set:
                fdb_fils[fdb_id] = f

        # Lokale Filamente laden (ueber custom_fields.filamentdb_id)
        local_by_fdb_id: dict[int, Filament] = {}

        # Strategie: Alle Filamente mit filamentdb_id laden
        local_result = await self.db.execute(
            select(Filament)
            .order_by(Filament.id)
            .options(
                selectinload(Filament.manufacturer),
                selectinload(Filament.filament_colors),
            )
            .where(Filament.custom_fields.isnot(None))
        )
        for fil in local_result.scalars().all():
            cf = fil.custom_fields
            if isinstance(cf, dict) and cf.get("filamentdb_id"):
                fid = requested_ids.get(str(cf["filamentdb_id"]))
                if fid is None or fid not in fdb_fils:
                    continue
                # Match the manufacturer scope used by preview and execution.
                mfr_name = fdb_mfr_map.get(_resolve_mfr_id(fdb_fils[fid]), "").lower()
                if fil.manufacturer and fil.manufacturer.name.lower() == mfr_name:
                    local_by_fdb_id[fid] = fil

        # Fallback: Filamente ueber Name+Hersteller+Material matchen
        if len(local_by_fdb_id) < len(fdb_fils):
            missing_ids = id_set - set(local_by_fdb_id.keys())
            catalog_id = cast(Filament.custom_fields["filamentdb_id"].as_string(), String)
            all_local_result = await self.db.execute(
                select(Filament).where(
                    catalog_id.is_(None) | (catalog_id == "")
                ).order_by(Filament.id).options(
                    selectinload(Filament.manufacturer),
                    selectinload(Filament.filament_colors),
                )
            )
            all_local = all_local_result.scalars().all()
            local_index: dict[tuple[str, str, str], Filament] = {}
            # Index fuer Fuzzy-Lookup: (mfr_lower, mat_lower) -> [(designation, Filament)]
            local_by_mfr_mat: dict[tuple[str, str], list[tuple[str, Filament]]] = (
                defaultdict(list)
            )
            for lf in all_local:
                mfr_name = (lf.manufacturer.name if lf.manufacturer else "").lower()
                desig = (lf.designation or "").lower()
                mat = (lf.material_type or "").lower()
                local_index[(mfr_name, desig, mat)] = lf
                local_by_mfr_mat[(mfr_name, mat)].append((lf.designation or "", lf))

            for fdb_id in missing_ids:
                fdb_f = fdb_fils.get(fdb_id)
                if not fdb_f:
                    continue
                mfr_name, designation, materials = _fdb_match_keys(
                    fdb_f, fdb_mfr_map, mat_map, mat_legacy_map
                )

                # Exakter Match
                matched = next(
                    (
                        local_index[key]
                        for m in materials
                        if (key := (mfr_name, designation, m)) in local_index
                    ),
                    None,
                )
                if matched:
                    local_by_fdb_id[fdb_id] = matched
                    continue

                # Fuzzy-Fallback
                fdb_desig_raw = (fdb_f.get("designation") or "").strip()
                candidates = [
                    c for m in materials for c in local_by_mfr_mat.get((mfr_name, m), [])
                ]
                best_fil, best_score = _best_fuzzy(
                    fdb_desig_raw,
                    [(d, f) for d, f in candidates],
                )
                if best_score >= FUZZY_THRESHOLD and best_fil is not None:
                    local_by_fdb_id[fdb_id] = best_fil

        # Diff erstellen
        results: list[dict[str, Any]] = []
        for fdb_id in filament_ids:
            fdb_f = fdb_fils.get(fdb_id)
            if not fdb_f:
                continue

            mfr_id_fdb = _resolve_mfr_id(fdb_f)
            mfr_name = fdb_mfr_map.get(mfr_id_fdb, "?") if mfr_id_fdb else "?"
            designation = fdb_f.get("designation") or "?"

            local = local_by_fdb_id.get(fdb_id)
            if not local:
                results.append(
                    {
                        "fdb_id": fdb_id,
                        "designation": designation,
                        "manufacturer_name": mfr_name,
                        "changes": [],
                        "identical": True,
                        "not_found": True,
                    }
                )
                continue

            changes: list[dict[str, Any]] = []
            material = fdb_f.get("material")
            material_id = fdb_f.get("material_id")
            if not material_id and isinstance(material, dict):
                material_id = material.get("id")
            material_type = mat_map.get(material_id) or _material_type_from_fdb(
                material if isinstance(material, dict) else {}
            )
            if local.material_type != material_type:
                changes.append({"field": "material_type", "old": local.material_type, "new": material_type})

            # Vergleich der Standard-Felder
            for fdb_key, local_attr, label in self._DIFF_FIELDS:
                fdb_val = fdb_f.get(fdb_key)
                local_val = getattr(local, local_attr, None)

                # Normalisierung
                if isinstance(fdb_val, str):
                    fdb_val = fdb_val.strip() or None
                if isinstance(local_val, str):
                    local_val = local_val.strip() or None

                # Float-Vergleich mit Toleranz
                if isinstance(fdb_val, (int, float)) and isinstance(
                    local_val, (int, float)
                ):
                    if abs(float(fdb_val) - float(local_val)) < 0.001:
                        continue
                elif fdb_val == local_val:
                    continue

                # None vs None = identisch
                if fdb_val is None and local_val is None:
                    continue

                changes.append(
                    {
                        "field": label,
                        "old": local_val,
                        "new": fdb_val,
                    }
                )

            for column, fdb_val in _temperature_ranges(fdb_f)[0].items():
                local_val = getattr(local, column, None)
                if fdb_val != local_val:
                    changes.append(
                        {
                            "field": column,
                            "old": local_val,
                            "new": fdb_val,
                        }
                    )

            sp_data = _resolve_spool_profile(fdb_f, sp_map)
            for column, fdb_val in standard_filamentdb_fields(
                {**fdb_f, 'spool_profile': sp_data}, base_url=FILAMENTDB_URL
            ).items():
                local_val = getattr(local, column, None)
                if fdb_val != local_val:
                    changes.append(
                        {
                            "field": column,
                            "old": local_val,
                            "new": fdb_val,
                        }
                    )

            # SpoolProfile-Felder vergleichen
            if sp_data:
                spool_fields = [
                    (
                        "empty_weight_g",
                        "default_spool_weight_g",
                        "default_spool_weight_g",
                    ),
                    (
                        "outer_diameter_mm",
                        "spool_outer_diameter_mm",
                        "spool_outer_diameter_mm",
                    ),
                    ("width_mm", "spool_width_mm", "spool_width_mm"),
                    ("spool_material", "spool_material", "spool_material"),
                ]
                for sp_key, local_attr, label in spool_fields:
                    fdb_val = sp_data.get(sp_key)
                    local_val = getattr(local, local_attr, None)

                    if isinstance(fdb_val, (int, float)) and isinstance(
                        local_val, (int, float)
                    ):
                        if abs(float(fdb_val) - float(local_val)) < 0.001:
                            continue
                    elif fdb_val == local_val:
                        continue

                    if fdb_val is None and local_val is None:
                        continue

                    changes.append(
                        {
                            "field": label,
                            "old": local_val,
                            "new": fdb_val,
                        }
                    )

            results.append(
                {
                    "fdb_id": fdb_id,
                    "local_id": local.id,
                    "designation": designation,
                    "manufacturer_name": mfr_name,
                    "changes": changes,
                    "identical": len(changes) == 0,
                }
            )

        return DiffResult(snapshot_id=snapshot.snapshot_id, results=copy.deepcopy(results))

    # ------------------------------------------------------------------ #
    #  Vorschau (komplett — wird intern von execute() genutzt)
    # ------------------------------------------------------------------ #

    async def preview(self, snapshot_id: str | None = None) -> ImportPreview:
        """Vorschau: welche Daten wuerden importiert?

        Fuegt jedem Manufacturer und Filament ein ``_exists``-Flag hinzu,
        das anzeigt, ob der Eintrag bereits in der lokalen DB vorhanden ist.
        Manufacturers bekommen zusaetzlich ``_filament_count`` und
        ``_material_types`` fuer die UI.
        """
        snapshot = await self._fetch_sync_data(snapshot_id=snapshot_id)
        data = snapshot.data

        manufacturers = copy.deepcopy(data.get("manufacturers", []))
        materials = data.get("materials", [])
        filaments = copy.deepcopy(data.get("filaments", []))
        spool_profiles = copy.deepcopy(data.get("spool_profiles", []))
        colors = self._extract_colors(filaments)

        # -- Duplikat-Abgleich: Manufacturers --
        existing_mfr_result = await self.db.execute(select(Manufacturer))
        existing_mfr_names: set[str] = {
            (m.name or "").lower() for m in existing_mfr_result.scalars().all()
        }

        for mfr in manufacturers:
            name = (mfr.get("name") or "").strip().lower()
            mfr["_exists"] = name in existing_mfr_names

        # -- Material-Map fuer Filament-Anreicherung --
        mat_map: dict[int, str] = {}
        for mat in materials:
            mid = mat.get("id")
            mkey = _material_type_from_fdb(mat)
            if mid:
                mat_map[mid] = mkey

        mat_legacy_map = {mat.get("id"): mat.get("key") for mat in materials}

        # -- FDB-Manufacturer-ID -> Name (fuer Filament-Duplikat-Check) --
        fdb_mfr_id_to_name: dict[int, str] = {}
        for mfr in manufacturers:
            fdb_id = mfr.get("id")
            if fdb_id:
                fdb_mfr_id_to_name[fdb_id] = (mfr.get("name") or "").strip()

        # -- Duplikat-Abgleich: Filaments --
        # Lade alle lokalen (manufacturer_name, designation, material_type)
        existing_fil_result = await self.db.execute(
            select(
                Filament.designation,
                Filament.material_type,
                Manufacturer.name,
                Filament.custom_fields["filamentdb_id"].as_string(),
            ).join(Manufacturer, Filament.manufacturer_id == Manufacturer.id).order_by(Filament.id)
        )
        existing_rows = existing_fil_result.all()
        existing_catalog_ids = {
            ((row[2] or "").lower(), str(row[3])) for row in existing_rows if row[3] is not None
        }
        existing_fil_keys: set[tuple[str, str, str]] = {
            (
                (row[2] or "").lower(),
                (row[0] or "").lower(),
                (row[1] or "").lower(),
            )
            for row in existing_rows if row[3] in (None, "")
        }

        # Filament-Zaehler und Materialtypen pro Manufacturer
        mfr_filament_counts: dict[int, int] = {}
        mfr_material_types: dict[int, set[str]] = {}

        for fil in filaments:
            # Manufacturer-ID auflösen
            mfr_id_fdb = fil.get("manufacturer_id")
            mfr_nested = fil.get("manufacturer")
            if not mfr_id_fdb and isinstance(mfr_nested, dict):
                mfr_id_fdb = mfr_nested.get("id")

            # Material auflösen
            mat_id_fdb = fil.get("material_id")
            mat_nested = fil.get("material")
            if not mat_id_fdb and isinstance(mat_nested, dict):
                mat_id_fdb = mat_nested.get("id")
            material_key = mat_map.get(mat_id_fdb, "PLA")
            if material_key == "PLA" and isinstance(mat_nested, dict):
                material_key = _material_type_from_fdb(mat_nested)

            fil["_material_key"] = material_key
            legacy_key = mat_legacy_map.get(mat_id_fdb)
            if legacy_key is None and isinstance(mat_nested, dict):
                legacy_key = mat_nested.get("key")
            material_keys = _material_type_aliases(material_key, legacy_key)

            # Zaehler / Material-Sets pro Manufacturer
            if mfr_id_fdb:
                mfr_filament_counts[mfr_id_fdb] = (
                    mfr_filament_counts.get(mfr_id_fdb, 0) + 1
                )
                mfr_material_types.setdefault(mfr_id_fdb, set()).add(material_key)

            # Duplikat-Check
            designation = (fil.get("designation") or "").strip()
            mfr_name = fdb_mfr_id_to_name.get(mfr_id_fdb, "") if mfr_id_fdb else ""
            known = (mfr_name.lower(), str(fil.get("id"))) in existing_catalog_ids
            known = known or any(
                (mfr_name.lower(), designation.lower(), material) in existing_fil_keys
                for material in material_keys
            )
            fil["_exists"] = known

        # Manufacturers anreichern
        for mfr in manufacturers:
            fdb_id = mfr.get("id")
            mfr["_filament_count"] = mfr_filament_counts.get(fdb_id, 0)
            mfr["_material_types"] = sorted(mfr_material_types.get(fdb_id, set()))

        return ImportPreview(
            snapshot_id=snapshot.snapshot_id,
            manufacturers=manufacturers,
            materials=copy.deepcopy(materials),
            filaments=filaments,
            spool_profiles=spool_profiles,
            colors=colors,
        )

    # ------------------------------------------------------------------ #
    #  Abgleich aller verknuepften Filamente
    # ------------------------------------------------------------------ #

    # Herstellerfelder, die die FilamentDB liefert (Name wird nie geaendert).
    _MFR_SPOOL_FIELDS: ClassVar[list[tuple[str, str]]] = [
        ("empty_weight_g", "empty_spool_weight_g"),
        ("outer_diameter_mm", "spool_outer_diameter_mm"),
        ("width_mm", "spool_width_mm"),
        ("spool_material", "spool_material"),
    ]
    _MFR_WRITABLE: ClassVar[frozenset[str]] = frozenset(
        {
            "url",
            "empty_spool_weight_g",
            "spool_outer_diameter_mm",
            "spool_width_mm",
            "spool_material",
            "logo",
            "label_logo",
        }
    )
    # Logo-Feld -> (FDB-Flag, URL-Unterordner, lokales Attribut, Dateisuffix)
    _LOGO_KINDS: ClassVar[dict[str, tuple[str, str, str, str]]] = {
        "logo": ("has_web_logo", "web", "logo_file", ".png"),
        "label_logo": ("has_label_logo", "label", "label_logo_file", "_label.png"),
    }
    # Logo-Feld -> (FDB-Zeitstempelfeld, lokaler custom_fields-Key)
    _LOGO_TS: ClassVar[dict[str, tuple[str, str]]] = {
        "logo": ("web_logo_updated_at", "filamentdb_logo_updated_at"),
        "label_logo": ("label_logo_updated_at", "filamentdb_label_logo_updated_at"),
    }

    @classmethod
    def _local_logo_ts(cls, mfr: Manufacturer, kind: str) -> str | None:
        cf = mfr.custom_fields
        val = cf.get(cls._LOGO_TS[kind][1]) if isinstance(cf, dict) else None
        return val if isinstance(val, str) and val else None

    @classmethod
    def _set_logo_ts(cls, mfr: Manufacturer, kind: str, ts: str | None) -> None:
        if not ts:
            return
        cf = dict(mfr.custom_fields) if isinstance(mfr.custom_fields, dict) else {}
        cf[cls._LOGO_TS[kind][1]] = ts
        mfr.custom_fields = cf

    @staticmethod
    def _check_logo_bytes(content: bytes) -> str | None:
        """Fehlertext, wenn die Datei kein gueltiges (PNG, <= 2 MB) Logo ist."""
        if len(content) > LOGO_MAX_BYTES:
            return "Datei groesser als 2 MB"
        if not content.startswith(LOGO_PNG_SIGNATURE):
            return "keine PNG-Datei"
        return None

    @staticmethod
    def _local_logo_sha(mfr: Manufacturer, attr: str) -> str | None:
        name = getattr(mfr, attr, None)
        if not name:
            return None
        path = LOGO_DIR / os.path.basename(name)
        try:
            return hashlib.sha256(path.read_bytes()).hexdigest()
        except OSError:
            return None

    async def _fetch_logo_changes(
        self,
        targets: list[tuple[Manufacturer, dict[str, Any]]],
        warnings: list[str],
        cache: dict[tuple[int, str], bytes],
        ts_cache: dict[tuple[int, str], str],
    ) -> dict[int, list[dict[str, Any]]]:
        """Logos der FDB laden und per SHA-256 mit den lokalen vergleichen."""
        jobs: list[tuple[Manufacturer, str, str, str | None]] = []
        for mfr, fdb_mfr in targets:
            slug = fdb_mfr.get("slug")
            if not slug:
                continue
            for kind, (flag, folder, attr, _suffix) in self._LOGO_KINDS.items():
                if not fdb_mfr.get(flag):
                    continue
                ts = fdb_mfr.get(self._LOGO_TS[kind][0])
                ts = ts if isinstance(ts, str) and ts else None
                if (
                    ts
                    and ts == self._local_logo_ts(mfr, kind)
                    and getattr(mfr, attr) is not None
                    and self._local_logo_sha(mfr, attr) is not None
                ):
                    continue  # unveraendert laut Zeitstempel, kein Download
                jobs.append((mfr, kind, f"{FILAMENTDB_URL}/uploads/logos/{folder}/{slug}.png", ts))
        out: dict[int, list[dict[str, Any]]] = defaultdict(list)
        if not jobs:
            return out
        sem = asyncio.Semaphore(LOGO_CONCURRENCY)

        async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:

            async def fetch(url: str) -> tuple[bytes | None, str | None]:
                async with sem:
                    try:
                        resp = await client.get(url)
                    except httpx.HTTPError as e:
                        return None, f"fehlgeschlagen: {e}"
                if resp.status_code != 200:
                    return None, f"nicht verfuegbar (HTTP {resp.status_code})"
                err = self._check_logo_bytes(resp.content)
                if err:
                    return None, f"verworfen ({err})"
                return resp.content, None

            fetched = await asyncio.gather(*(fetch(url) for _, _, url, _ in jobs))
        for (mfr, kind, _url, ts), (content, err) in zip(jobs, fetched, strict=True):
            label = "Logo" if kind == "logo" else "Etikett-Logo"
            if content is None:
                warnings.append(f"{label} fuer '{mfr.name}': {err}")
                continue
            new_sha = hashlib.sha256(content).hexdigest()
            old_sha = self._local_logo_sha(mfr, self._LOGO_KINDS[kind][2])
            if old_sha == new_sha:
                if ts and ts != self._local_logo_ts(mfr, kind):
                    self._set_logo_ts(mfr, kind, ts)  # reine Metadaten nachtragen
                continue
            cache[(mfr.id, kind)] = content
            if ts:
                ts_cache[(mfr.id, kind)] = ts
            out[mfr.id].append(
                {
                    "field": kind,
                    "old": "vorhanden" if old_sha else None,
                    "new": new_sha[:12],
                }
            )
        return out

    def _write_logo(self, mfr: Manufacturer, kind: str, content: bytes) -> None:
        """Logo atomar unter festem Namen schreiben und am Hersteller setzen."""
        _flag, _folder, attr, suffix = self._LOGO_KINDS[kind]
        filename = f"{mfr.id}{suffix}"
        LOGO_DIR.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=LOGO_DIR, suffix=".tmp")
        try:
            with os.fdopen(fd, "wb") as fh:
                fh.write(content)
            os.replace(tmp, LOGO_DIR / filename)
        except BaseException:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise
        setattr(mfr, attr, filename)
    _FILAMENT_PROTECTED: ClassVar[frozenset[str]] = frozenset(
        {"id", "manufacturer_id", "custom_fields", "label_field_aliases", "record_token"}
    )

    async def _linked_local_filaments(self) -> tuple[dict[int, Filament], int]:
        """Lokale Filamente mit gueltiger filamentdb_id: (FDB-ID -> Filament, unverknuepft)."""
        rows = await self.db.execute(
            select(Filament).order_by(Filament.id).options(selectinload(Filament.manufacturer))
        )
        linked: dict[int, Filament] = {}
        unlinked = 0
        for fil in rows.scalars().all():
            cf = fil.custom_fields
            raw = cf.get("filamentdb_id") if isinstance(cf, dict) else None
            try:
                fdb_id = int(raw) if raw not in (None, "") else None
            except (TypeError, ValueError):
                fdb_id = None
            if fdb_id is None:
                unlinked += 1
            else:
                linked.setdefault(fdb_id, fil)
        return linked, unlinked

    @staticmethod
    def _fdb_color_hexes(fil_data: dict[str, Any]) -> list[str]:
        """Farb-Hexwerte (lowercase) eines FDB-Filaments in Positionsreihenfolge."""
        colors = fil_data.get("colors") or []
        if not colors:
            hex_code = fil_data.get("hex_color")
            return [hex_code.lower()] if hex_code else []
        ordered: list[tuple[int, int, str]] = []
        for index, c in enumerate(colors):
            hex_code = c.get("hex_code") if isinstance(c, dict) else None
            if not hex_code:
                continue
            try:
                position = int(c.get("position") or 0)
            except (TypeError, ValueError):
                position = 0
            ordered.append((position if position >= 1 else 10**6, index, hex_code.lower()))
        return [hex_code for _, _, hex_code in sorted(ordered)]

    async def _linked_detail(self, snapshot_id: str | None = None) -> dict[str, Any]:
        """Abweichungen aller verknuepften Filamente, nach Hersteller gruppiert."""
        linked, unlinked_count = await self._linked_local_filaments()
        empty = {
            "snapshot_id": snapshot_id,
            "linked_count": len(linked),
            "unlinked_count": unlinked_count,
            "identical_count": 0,
            "missing_in_db": [],
            "manufacturers": [],
            "warnings": [],
            "_logo_cache": {},
            "_logo_ts": {},
        }
        if not linked:
            return empty

        diff = await self.diff_filaments(list(linked), snapshot_id=snapshot_id)
        snapshot = await self._fetch_sync_data(snapshot_id=diff.snapshot_id)
        data = snapshot.data
        fdb_fils = {f["id"]: f for f in data.get("filaments", []) if f.get("id")}
        fdb_mfr_names = {
            m["id"]: (m.get("name") or "").strip() for m in data.get("manufacturers", []) if m.get("id")
        }
        sp_map = {sp["id"]: sp for sp in data.get("spool_profiles", []) if sp.get("id")}

        found = [r for r in diff.results if not r.get("not_found") and r.get("local_id")]
        found_ids = {r["fdb_id"] for r in found}
        missing = [
            {
                "fdb_id": fdb_id,
                "designation": fil.designation,
                "manufacturer_name": fil.manufacturer.name if fil.manufacturer else "",
            }
            for fdb_id, fil in linked.items()
            if fdb_id not in found_ids
        ]

        # Lokale Farben je Filament (Hex in Positionsreihenfolge)
        local_colors: dict[int, list[str]] = defaultdict(list)
        if found:
            color_rows = await self.db.execute(
                select(FilamentColor.filament_id, Color.hex_code)
                .join(Color, Color.id == FilamentColor.color_id)
                .where(FilamentColor.filament_id.in_([r["local_id"] for r in found]))
                .order_by(FilamentColor.filament_id, FilamentColor.position)
            )
            for filament_id, hex_code in color_rows.all():
                local_colors[filament_id].append((hex_code or "").lower())

        groups: dict[int, dict[str, Any]] = {}
        identical_count = 0
        for r in found:
            fil_data = fdb_fils.get(r["fdb_id"])
            if not fil_data:
                continue
            fdb_mfr_id = _resolve_mfr_id(fil_data)
            if not fdb_mfr_id:
                continue
            group = groups.setdefault(fdb_mfr_id, {"filaments": []})
            changes = list(r["changes"])
            fdb_hex = self._fdb_color_hexes(fil_data)
            if fdb_hex and fdb_hex != local_colors.get(r["local_id"], []):
                changes.append(
                    {"field": "colors", "old": local_colors.get(r["local_id"], []), "new": fdb_hex}
                )
            if not changes:
                identical_count += 1
                continue
            group["filaments"].append(
                {
                    "fdb_id": r["fdb_id"],
                    "local_id": r["local_id"],
                    "designation": r["designation"],
                    "changes": changes,
                }
            )

        manufacturers: list[dict[str, Any]] = []
        pending: list[tuple[int, dict[str, Any], Manufacturer | None, str, list[dict[str, Any]], dict]] = []
        warnings: list[str] = []
        logo_cache: dict[tuple[int, str], bytes] = {}
        logo_ts: dict[tuple[int, str], str] = {}
        for fdb_mfr_id, group in groups.items():
            name = fdb_mfr_names.get(fdb_mfr_id, "")
            mfr_changes: list[dict[str, Any]] = []
            fdb_mfr: dict[str, Any] = {}
            mfr = (
                await self.db.execute(
                    select(Manufacturer).where(func.lower(Manufacturer.name) == name.lower())
                )
            ).scalars().first() if name else None
            if mfr is not None:
                fdb_mfr = next((m for m in data.get("manufacturers", []) if m.get("id") == fdb_mfr_id), {})
                website = (fdb_mfr.get("website") or "").strip() or None
                if website and website != mfr.url:
                    mfr_changes.append({"field": "url", "old": mfr.url, "new": website})
                # Haeufigstes Spulenprofil des Herstellers (wie beim Import)
                profile_ids = [
                    sp["id"]
                    for f in data.get("filaments", [])
                    if _resolve_mfr_id(f) == fdb_mfr_id
                    for sp in [_resolve_spool_profile(f, sp_map)]
                    if sp and sp.get("id")
                ]
                if profile_ids:
                    sp_data = sp_map.get(Counter(profile_ids).most_common(1)[0][0]) or {}
                    for sp_key, attr in self._MFR_SPOOL_FIELDS:
                        new = sp_data.get(sp_key)
                        old = getattr(mfr, attr)
                        if new is None:
                            continue
                        if isinstance(new, (int, float)) and isinstance(old, (int, float)):
                            if abs(float(new) - float(old)) < 0.001:
                                continue
                        elif new == old:
                            continue
                        mfr_changes.append({"field": attr, "old": old, "new": new})
            pending.append((fdb_mfr_id, group, mfr, name, mfr_changes, fdb_mfr))

        logo_changes = await self._fetch_logo_changes(
            [(m, f) for _, _, m, _, _, f in pending if m is not None], warnings, logo_cache, logo_ts
        )
        if self.db.dirty:
            await self.db.commit()
        for fdb_mfr_id, group, mfr, name, mfr_changes, _fdb_mfr in pending:
            if mfr is not None:
                mfr_changes.extend(logo_changes.get(mfr.id, []))
            if not mfr_changes and not group["filaments"]:
                continue
            manufacturers.append(
                {
                    "fdb_manufacturer_id": fdb_mfr_id,
                    "local_id": mfr.id if mfr is not None else None,
                    "name": mfr.name if mfr is not None else name,
                    "changes": mfr_changes,
                    "filaments": group["filaments"],
                }
            )
        manufacturers.sort(key=lambda g: g["name"].lower())
        return {
            "snapshot_id": snapshot.snapshot_id,
            "linked_count": len(linked),
            "unlinked_count": unlinked_count,
            "identical_count": identical_count,
            "missing_in_db": missing,
            "manufacturers": manufacturers,
            "warnings": warnings,
            "_logo_cache": logo_cache,
            "_logo_ts": logo_ts,
        }

    @staticmethod
    def _snapshot_maps(data: dict[str, Any]) -> tuple[dict[int, str], dict[int, str], dict[int, str]]:
        """(Hersteller-Namen, Material-Typ, Material-Legacy-Key) je ID aus einem Snapshot."""
        mfr_map = {
            m["id"]: (m.get("name") or "").strip() for m in data.get("manufacturers", []) if m.get("id")
        }
        mat_map: dict[int, str] = {}
        legacy_map: dict[int, str] = {}
        for mat in data.get("materials", []):
            if mat.get("id"):
                mat_map[mat["id"]] = _material_type_from_fdb(mat)
                legacy_map[mat["id"]] = (mat.get("key") or "").lower()
        return mfr_map, mat_map, legacy_map

    @staticmethod
    def _fdb_material_label(fil_data: dict[str, Any], mat_map: dict[int, str]) -> str:
        mat_id = fil_data.get("material_id")
        nested = fil_data.get("material")
        if not mat_id and isinstance(nested, dict):
            mat_id = nested.get("id")
        if mat_id in mat_map:
            return mat_map[mat_id]
        return _material_type_from_fdb(nested) if isinstance(nested, dict) else ""

    async def unlinked_suggestions(self, snapshot_id: str | None = None) -> dict[str, Any]:
        """Je unverknuepftem lokalem Filament den besten FDB-Kandidaten vorschlagen."""
        snapshot = await self._fetch_sync_data(snapshot_id=snapshot_id)
        data = snapshot.data
        mfr_map, mat_map, legacy_map = self._snapshot_maps(data)
        linked, _ = await self._linked_local_filaments()

        # FDB-Index: (Hersteller lower, Material lower) -> [(Bezeichnung, FDB-Filament)]
        fdb_index: dict[tuple[str, str], list[tuple[str, dict[str, Any]]]] = defaultdict(list)
        for f in data.get("filaments", []):
            if not f.get("id"):
                continue
            mfr_name, _desig, materials = _fdb_match_keys(f, mfr_map, mat_map, legacy_map)
            for m in materials:
                fdb_index[(mfr_name, m)].append((f.get("designation") or "", f))

        rows = await self.db.execute(
            select(Filament).order_by(Filament.id).options(selectinload(Filament.manufacturer))
        )
        def _has_catalog_id(fil: Filament) -> bool:
            cf = fil.custom_fields
            raw = cf.get("filamentdb_id") if isinstance(cf, dict) else None
            if raw in (None, ""):
                return False
            try:
                int(raw)
            except (TypeError, ValueError):
                return False
            return True

        # Mehrere lokale Filamente koennen dieselbe FDB-ID tragen; alle gelten als verknuepft.
        unlinked = [fil for fil in rows.scalars().all() if not _has_catalog_id(fil)]
        local_colors: dict[int, list[str]] = defaultdict(list)
        if unlinked:
            color_rows = await self.db.execute(
                select(FilamentColor.filament_id, Color.hex_code)
                .join(Color, Color.id == FilamentColor.color_id)
                .where(FilamentColor.filament_id.in_([fil.id for fil in unlinked]))
                .order_by(FilamentColor.filament_id, FilamentColor.position)
            )
            for filament_id, hex_code in color_rows.all():
                local_colors[filament_id].append((hex_code or "").lower())

        items: list[dict[str, Any]] = []
        for fil in unlinked:
            mfr_name = (fil.manufacturer.name if fil.manufacturer else "").lower()
            desig = (fil.designation or "").strip()
            candidates = fdb_index.get((mfr_name, (fil.material_type or "").lower()), [])
            suggestion: dict[str, Any] | None = None
            match = next((f for d, f in candidates if d.strip().lower() == desig.lower()), None)
            score = 1.0
            exact = match is not None
            if match is None:
                match, score = _best_fuzzy(desig, candidates)
                if score < FUZZY_THRESHOLD:
                    match = None
            if match is not None:
                fdb_mfr_id = _resolve_mfr_id(match)
                suggestion = {
                    "fdb_id": match["id"],
                    "designation": match.get("designation") or "",
                    "manufacturer_name": mfr_map.get(fdb_mfr_id, "") if fdb_mfr_id else "",
                    "material_type": self._fdb_material_label(match, mat_map),
                    "colors": self._fdb_color_hexes(match),
                    "score": round(score, 4),
                    "exact": exact,
                    "already_linked_to": linked[match["id"]].id if match["id"] in linked else None,
                }
            items.append(
                {
                    "local_id": fil.id,
                    "designation": fil.designation or "",
                    "manufacturer_name": fil.manufacturer.name if fil.manufacturer else "",
                    "material_type": fil.material_type or "",
                    "colors": local_colors.get(fil.id, []),
                    "suggestion": suggestion,
                }
            )
        items.sort(key=lambda i: (i["manufacturer_name"].lower(), i["designation"].lower()))
        return {"snapshot_id": snapshot.snapshot_id, "items": items}

    async def link_filaments(
        self, items: list[dict[str, Any]], snapshot_id: str | None = None
    ) -> dict[str, Any]:
        """Lokale Filamente mit FDB-Filamenten verknuepfen (setzt nur custom_fields.filamentdb_id)."""
        snapshot = await self._fetch_sync_data(snapshot_id=snapshot_id)
        data = snapshot.data
        mfr_map, _, _ = self._snapshot_maps(data)
        fdb_fils = {f["id"]: f for f in data.get("filaments", []) if f.get("id")}
        linked, _ = await self._linked_local_filaments()
        warnings: list[str] = []
        done = 0
        claimed: dict[int, int] = {}  # fdb_id -> local_id in diesem Aufruf
        for item in items:
            try:
                local_id = int(item["local_id"])
                fdb_id = int(item["fdb_id"])
            except (KeyError, TypeError, ValueError):
                warnings.append(f"Ungueltiger Eintrag uebersprungen: {item!r}")
                continue
            fil = (
                await self.db.execute(
                    select(Filament)
                    .where(Filament.id == local_id)
                    .options(selectinload(Filament.manufacturer))
                )
            ).scalar_one_or_none()
            if fil is None:
                warnings.append(f"Filament #{local_id} existiert nicht.")
                continue
            cf = fil.custom_fields
            if isinstance(cf, dict) and cf.get("filamentdb_id") not in (None, ""):
                warnings.append(f"Filament #{local_id} ist bereits verknuepft.")
                continue
            fdb_f = fdb_fils.get(fdb_id)
            if fdb_f is None:
                warnings.append(f"FilamentDB-ID {fdb_id} nicht im Snapshot (Filament #{local_id}).")
                continue
            fdb_mfr_id = _resolve_mfr_id(fdb_f)
            fdb_mfr = mfr_map.get(fdb_mfr_id, "").lower() if fdb_mfr_id else ""
            local_mfr = (fil.manufacturer.name if fil.manufacturer else "").lower()
            if not fdb_mfr or fdb_mfr != local_mfr:
                warnings.append(f"Hersteller passt nicht fuer Filament #{local_id} (FilamentDB {fdb_id}).")
                continue
            other = linked.get(fdb_id)
            other_id = other.id if other is not None else claimed.get(fdb_id)
            if other_id is not None and other_id != local_id:
                warnings.append(
                    f"FilamentDB-ID {fdb_id} ist bereits mit Filament #{other_id} verknuepft."
                )
            new_cf = dict(cf) if isinstance(cf, dict) else {}
            new_cf["filamentdb_id"] = fdb_id
            fil.custom_fields = new_cf
            claimed.setdefault(fdb_id, local_id)
            await mark_in_sync(self.db, "filament", local_id)
            done += 1
        await self.db.commit()
        return {"linked": done, "warnings": warnings}

    async def diff_linked_filaments(self, snapshot_id: str | None = None) -> dict[str, Any]:
        """Alle mit der FilamentDB verknuepften lokalen Filamente abgleichen."""
        detail = await self._linked_detail(snapshot_id)
        detail.pop("_logo_cache", None)
        detail.pop("_logo_ts", None)
        return detail

    async def update_linked_filaments(
        self,
        filaments: list[dict[str, Any]],
        manufacturers: list[dict[str, Any]] | None = None,
        snapshot_id: str | None = None,
    ) -> ImportResult:
        """Ausgewaehlte Felder verknuepfter Filamente/Hersteller aktualisieren.

        ``filaments``: ``[{"fdb_id": int, "fields": [str]}]``,
        ``manufacturers``: ``[{"fdb_manufacturer_id": int, "fields": [str]}]``.
        Der Diff wird serverseitig neu berechnet; geschrieben werden nur dort
        vorhandene Felder mit dem dort berechneten Wert. Es werden weder
        Filamente noch Hersteller angelegt.
        """
        result = ImportResult()
        if not filaments and not manufacturers:
            return result
        detail = await self._linked_detail(snapshot_id)
        snapshot = await self._fetch_sync_data(snapshot_id=detail["snapshot_id"])
        fdb_fils = {f["id"]: f for f in snapshot.data.get("filaments", []) if f.get("id")}
        fil_index = {f["fdb_id"]: f for g in detail["manufacturers"] for f in g["filaments"]}
        mfr_index = {g["fdb_manufacturer_id"]: g for g in detail["manufacturers"]}

        for req in filaments or []:
            fdb_id = req.get("fdb_id")
            entry = fil_index.get(fdb_id)
            if entry is None:
                result.warnings.append(
                    f"FilamentDB #{fdb_id}: nicht verknuepft oder ohne Abweichung, ignoriert"
                )
                continue
            known = {c["field"]: c["new"] for c in entry["changes"]}
            wanted = list(dict.fromkeys(req.get("fields") or []))
            unknown = [f for f in wanted if f not in known]
            if unknown:
                result.warnings.append(f"FilamentDB #{fdb_id}: unbekannte Felder ignoriert: {unknown}")
            chosen = {f: copy.deepcopy(known[f]) for f in wanted if f in known}
            if not chosen:
                continue
            await self._apply_linked_filament_changes(
                entry["local_id"], fdb_fils[fdb_id], chosen, result
            )
            result.filaments_updated += 1

        for req in manufacturers or []:
            fdb_mfr_id = req.get("fdb_manufacturer_id")
            group = mfr_index.get(fdb_mfr_id)
            if group is None or not group.get("local_id") or not group["changes"]:
                result.warnings.append(
                    f"FilamentDB-Hersteller #{fdb_mfr_id}: nicht verknuepft oder ohne Abweichung, ignoriert"
                )
                continue
            known = {c["field"]: c["new"] for c in group["changes"]}
            wanted = list(dict.fromkeys(req.get("fields") or []))
            unknown = [f for f in wanted if f not in known or f not in self._MFR_WRITABLE]
            if unknown:
                result.warnings.append(
                    f"FilamentDB-Hersteller #{fdb_mfr_id}: unbekannte Felder ignoriert: {unknown}"
                )
            chosen = {f: known[f] for f in wanted if f in known and f in self._MFR_WRITABLE}
            if not chosen:
                continue
            mfr = await self.db.get(Manufacturer, group["local_id"])
            if mfr is None:
                continue
            for field_name, value in chosen.items():
                if field_name in self._LOGO_KINDS:
                    content = detail["_logo_cache"].get((mfr.id, field_name))
                    err = self._check_logo_bytes(content) if content is not None else "nicht geladen"
                    if err is None and hashlib.sha256(content).hexdigest()[:12] != value:
                        err = "Inhalt weicht vom Abgleich ab"
                    if err is not None:
                        result.warnings.append(f"Logo fuer '{mfr.name}' nicht geschrieben: {err}")
                        continue
                    self._write_logo(mfr, field_name, content)
                    self._set_logo_ts(mfr, field_name, detail["_logo_ts"].get((mfr.id, field_name)))
                    result.logos_downloaded += 1
                    continue
                setattr(mfr, field_name, value)
            result.manufacturers_updated += 1
            await mark_in_sync(self.db, "manufacturer", mfr.id)

        await self.db.commit()
        return result

    async def _apply_linked_filament_changes(
        self,
        local_id: int,
        fil_data: dict[str, Any],
        chosen: dict[str, Any],
        result: ImportResult,
    ) -> None:
        """Nur die gewaehlten, im Diff berechneten Felder in ein Filament schreiben."""
        local = await self.db.get(Filament, local_id)
        if local is None:
            result.errors.append(f"Lokales Filament {local_id} nicht gefunden")
            return
        promoted: dict[str, Any] = {}
        for field_name, value in chosen.items():
            if field_name == "colors":
                continue
            if field_name == "material_type":
                if (local.material_type or "").casefold() != (value or "").casefold():
                    await clear_bambu_idx_for_filament(self.db, local.id)
                local.material_type = value
                continue
            if field_name in self._FILAMENT_PROTECTED or not hasattr(Filament, field_name):
                result.warnings.append(f"Feld '{field_name}' wird nicht geschrieben")
                continue
            setattr(local, field_name, value)
            promoted[field_name] = value
        if promoted:
            aliases = catalog_promotion_aliases(
                fil_data, promoted, local.custom_fields, local.label_field_aliases
            )
            if aliases:
                local.label_field_aliases = {**(local.label_field_aliases or {}), **aliases}
        if "colors" in chosen:
            # Fehlende Farb-Datensaetze ueber die bestehende Import-Logik anlegen.
            color_map = await self._import_colors(self._extract_colors([fil_data]), ImportResult())
            await self._create_filament_colors(local.id, fil_data, color_map)
        await self.db.flush()
        await mark_in_sync(self.db, "filament", local.id)

    # ------------------------------------------------------------------ #
    #  Import ausfuehren
    # ------------------------------------------------------------------ #

    async def execute(
        self,
        spool_detail_target: Literal["filament", "manufacturer", "both"] = "filament",
        manufacturer_ids: list[int] | None = None,
        filament_ids: list[int] | None = None,
        update_filament_ids: list[int] | None = None,
        skip_fuzzy_ids: list[int] | None = None,
        snapshot_id: str | None = None,
    ) -> ImportResult:
        """Import aus der FilamentDB ausfuehren.

        Args:
            spool_detail_target: Wohin SpoolProfile-Daten geschrieben werden.
            manufacturer_ids: FilamentDB-IDs der gewaehlten Hersteller.
                              ``None`` importiert alle.
            filament_ids: FilamentDB-IDs der gewaehlten Filamente.
                          ``None`` importiert alle Filamente der gewaehlten Hersteller.
            update_filament_ids: FilamentDB-IDs existierender Filamente,
                                 die aktualisiert werden sollen.
            skip_fuzzy_ids: FilamentDB-IDs, fuer die Fuzzy-Matching
                            uebersprungen wird (User hat Match abgelehnt).
            snapshot_id: Optionale Snapshot-ID fuer Cache-Reuse.
        """
        result = ImportResult()
        preview = await self.preview(snapshot_id=snapshot_id)

        # -- Filtern nach Auswahl --
        selected_manufacturers = preview.manufacturers
        if manufacturer_ids is not None:
            mfr_id_set = set(manufacturer_ids)
            selected_manufacturers = [
                m for m in preview.manufacturers if m.get("id") in mfr_id_set
            ]

        selected_filaments = preview.filaments
        if filament_ids is not None:
            fil_id_set = set(filament_ids)
            selected_filaments = [
                f for f in preview.filaments if f.get("id") in fil_id_set
            ]
        elif manufacturer_ids is not None:
            # Alle Filamente der gewaehlten Hersteller
            mfr_id_set = set(manufacturer_ids)
            selected_filaments = [
                f for f in preview.filaments if _resolve_mfr_id(f) in mfr_id_set
            ]

        # Colors nur fuer ausgewaehlte Filamente
        selected_colors = self._extract_colors(selected_filaments)

        # Material-Map: filamentdb_material_id -> material_key
        material_map: dict[int, str] = {}
        for mat in preview.materials:
            mat_id = mat.get("id")
            mat_key = _material_type_from_fdb(mat)
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
            selected_manufacturers, result
        )

        # 2. Colors importieren
        color_map = await self._import_colors(selected_colors, result)

        # 3. Filaments importieren
        await self._import_filaments(
            selected_filaments,
            material_map,
            manufacturer_map,
            color_map,
            spool_profile_map,
            spool_detail_target,
            result,
            update_filament_ids=update_filament_ids,
            skip_fuzzy_ids=skip_fuzzy_ids,
            legacy_material_map={mat.get("id"): mat.get("key") for mat in preview.materials},
        )

        # 4. SpoolProfile auf Manufacturer-Ebene (wenn gewuenscht)
        if spool_detail_target in ("manufacturer", "both"):
            await self._apply_spool_profiles_to_manufacturers(
                selected_filaments, manufacturer_map, spool_profile_map, result
            )

        # 5. Logos herunterladen
        await self._download_manufacturer_logos(
            selected_manufacturers, manufacturer_map, result
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
        update_filament_ids: list[int] | None = None,
        skip_fuzzy_ids: list[int] | None = None,
        legacy_material_map: dict[int, str | None] | None = None,
    ) -> dict[int, int]:
        """Filamente importieren. Gibt FilamentDB-ID -> FilaMan-ID."""
        fil_map: dict[int, int] = {}
        update_id_set = set(update_filament_ids) if update_filament_ids else set()
        skip_fuzzy_set = set(skip_fuzzy_ids) if skip_fuzzy_ids else set()
        catalog_id = cast(Filament.custom_fields["filamentdb_id"].as_string(), String)
        unlinked = catalog_id.is_(None) | (catalog_id == "")
        # Resolve the whole batch before writes can change subsequent matches.
        pending: list[tuple[dict[str, Any], int, str, str, Filament | None]] = []

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
                material_key = _material_type_from_fdb(mat_nested)

            designation = (fil_data.get("designation") or "").strip()
            if not designation:
                designation = f"{material_key} (FilamentDB #{fdb_id})"

            legacy_key = (legacy_material_map or {}).get(material_id_fdb)
            if legacy_key is None and isinstance(mat_nested, dict):
                legacy_key = mat_nested.get("key")
            material_keys = _material_type_aliases(material_key, legacy_key)

            # A saved catalog identity survives material/display-name changes.
            existing_matches = []
            if fdb_id:
                linked = await self.db.execute(
                    select(Filament).where(
                        Filament.manufacturer_id == filaman_mfr_id,
                        catalog_id == str(fdb_id),
                    )
                )
                existing_matches = list(linked.scalars())

            # Duplicate-Check: exakt, dann fuzzy
            if not existing_matches:
                existing = await self.db.execute(
                    select(Filament).where(
                        (Filament.manufacturer_id == filaman_mfr_id)
                        & (func.lower(Filament.designation) == designation.lower())
                        & (func.lower(Filament.material_type).in_(material_keys))
                        & unlinked
                    )
                )
                existing_matches = list(existing.scalars())
            if len(existing_matches) > 1:
                result.warnings.append(
                    f"FilamentDB #{fdb_id}: multiple local matches; resolve duplicates before updating."
                )
                result.filaments_skipped += 1
                continue
            existing_fil = existing_matches[0] if existing_matches else None

            # Fuzzy-Fallback wenn kein exakter Match
            if not existing_fil and fdb_id not in skip_fuzzy_set:
                fuzzy_candidates_result = await self.db.execute(
                    select(Filament).where(
                        (Filament.manufacturer_id == filaman_mfr_id)
                        & (func.lower(Filament.material_type).in_(material_keys))
                        & unlinked
                    )
                )
                best_score = 0.0
                best_candidate: Filament | None = None
                # Match preview/diff priority: display name, legacy key, then local ID.
                candidates = sorted(
                    fuzzy_candidates_result.scalars(),
                    key=lambda row: (material_keys.index(row.material_type.lower()), row.id),
                )
                for candidate in candidates:
                    score = fuzzy_token_score(candidate.designation or "", designation)
                    if score > best_score:
                        best_score = score
                        best_candidate = candidate
                if best_score >= FUZZY_THRESHOLD and best_candidate is not None:
                    existing_fil = best_candidate

            pending.append((fil_data, filaman_mfr_id, material_key, designation, existing_fil))

        claimed_catalog_ids: dict[int, int] = {}
        for fil_data, filaman_mfr_id, material_key, designation, existing_fil in pending:
            fdb_id = fil_data.get("id")
            if existing_fil:
                claimed_id = claimed_catalog_ids.get(existing_fil.id)
                if claimed_id is not None and claimed_id != fdb_id:
                    result.warnings.append(
                        f"FilamentDB #{fdb_id}: local filament #{existing_fil.id} already updated "
                        f"for FilamentDB #{claimed_id}; skipped conflicting match."
                    )
                    result.filaments_skipped += 1
                    continue
                if fdb_id:
                    fil_map[fdb_id] = existing_fil.id

                # Update wenn gewuenscht
                if fdb_id and fdb_id in update_id_set:
                    await self._update_existing_filament(
                        existing_fil,
                        fil_data,
                        material_key,
                        spool_profile_map,
                        spool_detail_target,
                        color_map,
                    )
                    # custom_fields aktualisieren (filamentdb_id sicherstellen)
                    cf = dict(existing_fil.custom_fields or {})
                    cf["filamentdb_id"] = fdb_id
                    existing_fil.custom_fields = cf
                    await self.db.flush()
                    claimed_catalog_ids[existing_fil.id] = fdb_id
                    await mark_in_sync(self.db, "filament", existing_fil.id)
                    result.filaments_updated += 1
                else:
                    result.filaments_skipped += 1
                continue

            # SpoolProfile-Daten fuer Filament-Ebene
            spool_weight_g: float | None = None
            spool_diameter: float | None = None
            spool_width: float | None = None
            spool_material: str | None = None

            sp_data = _resolve_spool_profile(fil_data, spool_profile_map)
            if spool_detail_target in ("filament", "both") and sp_data:
                spool_weight_g = sp_data.get("empty_weight_g")
                spool_diameter = sp_data.get("outer_diameter_mm")
                spool_width = sp_data.get("width_mm")
                spool_material = sp_data.get("spool_material")

            # Farb-Modus
            color_mode = fil_data.get("color_mode", "single")
            multi_color_style = fil_data.get("multi_color_style")

            # Custom-Fields fuer nicht gemappte Daten
            custom: dict[str, Any] = {}
            temperature_ranges, migrated_temperature_keys = _temperature_ranges(
                fil_data
            )
            standard_fields = standard_filamentdb_fields(
                {**fil_data, 'spool_profile': sp_data}, base_url=FILAMENTDB_URL
            )
            if fdb_id:
                custom["filamentdb_id"] = fdb_id
            if fil_data.get("currency") is not None and "price_currency" not in standard_fields:
                custom["currency"] = fil_data["currency"]
            for temp_key in (
                "temp_nozzle_min",
                "temp_nozzle_max",
                "temp_bed",
            ):
                val = fil_data.get(temp_key)
                if val is not None and temp_key not in migrated_temperature_keys:
                    custom[temp_key] = val
            if "cooling_fan_range_percent" not in standard_fields:
                for fan_key in ("fan_speed_min", "fan_speed_max"):
                    if fil_data.get(fan_key) is not None:
                        custom[fan_key] = fil_data[fan_key]

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
                **temperature_ranges,
                **standard_fields,
                label_field_aliases=catalog_promotion_aliases(
                    fil_data, {**temperature_ranges, **standard_fields}
                ) or None,
                color_mode=color_mode,
                multi_color_style=multi_color_style,
                custom_fields=custom if custom else None,
            )
            await apply_defaults_to_new_filament(
                self.db, new_fil, await self.db.get(Manufacturer, filaman_mfr_id)
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
    #  Existierendes Filament aktualisieren
    # ------------------------------------------------------------------ #

    async def _update_existing_filament(
        self,
        existing: Filament,
        fil_data: dict[str, Any],
        material_key: str,
        spool_profile_map: dict[int, dict[str, Any]],
        spool_detail_target: Literal["filament", "manufacturer", "both"],
        color_map: dict[str, int],
    ) -> None:
        """Felder eines existierenden Filaments mit FDB-Daten aktualisieren."""
        # Standard-Felder aktualisieren
        existing.designation = (
            fil_data.get("designation") or existing.designation
        ).strip()
        previous_material = (existing.material_type or "").casefold()
        existing.material_type = material_key
        if previous_material != (material_key or "").casefold():
            removed = await clear_bambu_idx_for_filament(self.db, existing.id)
            if removed:
                logger.info(
                    "Cleared %s bambu_idx row(s) after FilamentDB updated filament %s",
                    removed,
                    existing.id,
                )
        existing.material_subgroup = (
            fil_data.get("material_subtype") or existing.material_subgroup
        )
        existing.diameter_mm = fil_data.get("diameter_mm") or existing.diameter_mm
        existing.manufacturer_color_name = (
            fil_data.get("color_name") or existing.manufacturer_color_name
        )
        existing.raw_material_weight_g = (
            fil_data.get("nominal_weight_g")
            if fil_data.get("nominal_weight_g") is not None
            else existing.raw_material_weight_g
        )
        existing.price = (
            fil_data.get("price")
            if fil_data.get("price") is not None
            else existing.price
        )
        existing.shop_url = (
            fil_data.get("shop_url")
            if fil_data.get("shop_url") is not None
            else existing.shop_url
        )
        existing.density_g_cm3 = (
            fil_data.get("density_g_cm3")
            if fil_data.get("density_g_cm3") is not None
            else existing.density_g_cm3
        )
        temperature_ranges, migrated_temperature_keys = _temperature_ranges(fil_data)
        for column, value in temperature_ranges.items():
            setattr(existing, column, value)
        sp_data = _resolve_spool_profile(fil_data, spool_profile_map)
        standard_fields = standard_filamentdb_fields({**fil_data, 'spool_profile': sp_data}, base_url=FILAMENTDB_URL)
        for column, value in standard_fields.items():
            setattr(existing, column, value)
        existing.label_field_aliases = {
            **(existing.label_field_aliases or {}),
            **catalog_promotion_aliases(
                fil_data, {**temperature_ranges, **standard_fields},
                existing.custom_fields, existing.label_field_aliases,
            ),
        } or None
        existing.color_mode = fil_data.get("color_mode", existing.color_mode)
        existing.multi_color_style = (
            fil_data.get("multi_color_style") or existing.multi_color_style
        )

        # SpoolProfile-Daten
        if spool_detail_target in ("filament", "both") and sp_data:
            existing.default_spool_weight_g = (
                sp_data.get("empty_weight_g")
                if sp_data.get("empty_weight_g") is not None
                else existing.default_spool_weight_g
            )
            existing.spool_outer_diameter_mm = (
                sp_data.get("outer_diameter_mm")
                if sp_data.get("outer_diameter_mm") is not None
                else existing.spool_outer_diameter_mm
            )
            existing.spool_width_mm = (
                sp_data.get("width_mm")
                if sp_data.get("width_mm") is not None
                else existing.spool_width_mm
            )
            existing.spool_material = (
                sp_data.get("spool_material") or existing.spool_material
            )

        # Custom-Fields aktualisieren (temp/print-settings)
        # Copy before mutation so JSON changes survive the colors helper's flush.
        custom = dict(existing.custom_fields or {})
        # Field names alone do not prove catalog ownership; retain existing user extras.
        if fil_data.get("currency") is not None and "price_currency" not in standard_fields:
            custom.setdefault("currency", fil_data["currency"])
        for temp_key in (
            "temp_nozzle_min",
            "temp_nozzle_max",
            "temp_bed",
        ):
            val = fil_data.get(temp_key)
            if val is not None and temp_key not in migrated_temperature_keys:
                custom.setdefault(temp_key, val)
        if "cooling_fan_range_percent" not in standard_fields:
            for fan_key in ("fan_speed_min", "fan_speed_max"):
                if fil_data.get(fan_key) is not None:
                    custom.setdefault(fan_key, fil_data[fan_key])
        existing.custom_fields = custom

        # FilamentColors neu aufbauen (Helper raeumt alte Zuordnungen defensiv auf)
        await self._create_filament_colors(existing.id, fil_data, color_map)

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
        # Defensiv alte Zuordnungen entfernen: SQLite kann IDs wiederverwenden,
        # und aeltere Datenbanken koennen dadurch noch verwaiste Farbzeilen haben.
        await self.db.execute(
            delete(FilamentColor).where(FilamentColor.filament_id == filament_id)
        )
        await self.db.flush()

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
            await self.db.flush()
            return

        used_positions: set[int] = set()
        next_position = 1
        for c in fil_colors:
            hex_code = c.get("hex_code")
            if not hex_code:
                continue

            color_id = color_map.get(hex_code.lower())
            if not color_id:
                continue

            raw_position = c.get("position", 0)
            try:
                position = int(raw_position) if raw_position is not None else 0
            except (TypeError, ValueError):
                position = 0

            # Bei doppelter, ungueltiger oder fehlender Position: naechste freie vergeben
            if position < 1 or position in used_positions:
                while next_position in used_positions:
                    next_position += 1
                position = next_position

            used_positions.add(position)
            next_position = max(next_position, position + 1)
            display_name = c.get("color_name")

            fc = FilamentColor(
                filament_id=filament_id,
                color_id=color_id,
                position=position,
                display_name_override=display_name,
            )
            self.db.add(fc)

        await self.db.flush()

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
                has_label_logo = mfr_data.get("has_label_logo", False)

                if (not has_logo and not has_label_logo) or not slug:
                    continue

                filaman_mfr_id = manufacturer_map.get(fdb_id)
                if not filaman_mfr_id:
                    continue

                # Download web logo
                if has_logo:
                    logo_filename = f"{filaman_mfr_id}.png"
                    logo_path = LOGO_DIR / logo_filename

                    if not logo_path.exists():
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
                                    self._set_logo_ts(mfr, "logo", mfr_data.get("web_logo_updated_at"))
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

                # Download label logo (grayscale, for label printing)
                if has_label_logo:
                    label_filename = f"{filaman_mfr_id}_label.png"
                    label_path = LOGO_DIR / label_filename

                    if not label_path.exists():
                        label_url = f"{FILAMENTDB_URL}/uploads/logos/label/{slug}.png"
                        try:
                            resp = await client.get(label_url)
                            if resp.status_code == 200:
                                label_path.write_bytes(resp.content)

                                # DB updaten
                                mfr_result = await self.db.execute(
                                    select(Manufacturer).where(
                                        Manufacturer.id == filaman_mfr_id
                                    )
                                )
                                mfr = mfr_result.scalar_one_or_none()
                                if mfr:
                                    mfr.label_logo_file = label_filename
                                    self._set_logo_ts(mfr, "label_logo", mfr_data.get("label_logo_updated_at"))
                                result.logos_downloaded += 1
                            else:
                                result.warnings.append(
                                    f"Label-Logo fuer '{mfr_data.get('name', '?')}' nicht verfuegbar "
                                    f"(HTTP {resp.status_code})"
                                )
                        except httpx.RequestError as e:
                            result.warnings.append(
                                f"Label-Logo-Download fuer '{mfr_data.get('name', '?')}' "
                                f"fehlgeschlagen: {e}"
                            )
