"""FilamentDB-Import-Service: Daten aus der FilamentDB importieren."""

import logging
import re
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from typing import Any, Literal

import httpx
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.models.filament import Color, Filament, FilamentColor, Manufacturer

logger = logging.getLogger(__name__)

# Feste FilamentDB-URL (nicht konfigurierbar)
FILAMENTDB_URL = "https://db.filaman.app"

# Standard-Timeout fuer HTTP-Requests
HTTP_TIMEOUT = 30.0

# Uploads-Verzeichnis fuer Hersteller-Logos (persistenter Pfad)
from app.core.config import MANUFACTURER_LOGO_DIR as LOGO_DIR

# Schwellwert fuer Fuzzy-Matching (75%)
FUZZY_THRESHOLD = 0.75

# Synonyme fuer Normalisierung (werden auf die kanonische Form gemappt)
_SYNONYMS: dict[str, str] = {
    "+": "plus",
}


def _normalize_designation(name: str) -> str:
    """Normalisiert eine Filament-Bezeichnung fuer Fuzzy-Matching.

    - Lowercase
    - Klammern werden zu Leerzeichen (Inhalt bleibt erhalten)
    - Sonderzeichen (_, -, /, ,) → Leerzeichen
    - Whitespace normalisieren
    """
    s = name.lower().strip()
    s = re.sub(r"[()[\]{}<>]", " ", s)
    s = re.sub(r"[_,\-/]", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s


def _tokenize(name: str) -> set[str]:
    """Tokenisiert und vereinheitlicht Synonyme."""
    tokens: set[str] = set()
    for tok in _normalize_designation(name).split():
        tokens.add(_SYNONYMS.get(tok, tok))
    return tokens


def _fuzzy_match_score(a: str, b: str) -> float:
    """Symmetrischer Token-Overlap Score.

    Gibt den hoeheren Wert aus beiden Richtungen zurueck:
      max(|A∩B|/|A|, |A∩B|/|B|)

    So matchen sowohl "Feuerrot" vs "Rot (Feuerrot)" als auch
    "PLA Rot (Feuerrot)" vs "PLA Rot".
    """
    tokens_a = _tokenize(a)
    tokens_b = _tokenize(b)
    if not tokens_a or not tokens_b:
        return 0.0
    overlap = len(tokens_a & tokens_b)
    return max(overlap / len(tokens_a), overlap / len(tokens_b))


def _resolve_mfr_id(fil: dict[str, Any]) -> int | None:
    """FilamentDB-Manufacturer-ID aus einem Filament-Dict auflösen."""
    mfr_id = fil.get("manufacturer_id")
    if mfr_id:
        return mfr_id
    mfr_nested = fil.get("manufacturer")
    if isinstance(mfr_nested, dict):
        return mfr_nested.get("id")
    return None


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
class ManufacturerPreview:
    """Leichtgewichtige Vorschau — nur Hersteller + Materialien (keine Filamente)."""

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

    filaments: list[dict[str, Any]] = field(default_factory=list)
    colors: list[dict[str, str]] = field(default_factory=list)


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
    #  Leichtgewichtige Vorschau (nur Hersteller + Materialien)
    # ------------------------------------------------------------------ #

    async def preview_manufacturers(self) -> ManufacturerPreview:
        """Vorschau: nur Hersteller und Materialien zurueckgeben.

        Filamente werden intern gelesen (fuer ``_filament_count`` und
        ``_material_types``), aber NICHT an den Caller zurueckgegeben.
        Das spart bei 40k+ Filamenten enorm Bandbreite.
        """
        data = await self._fetch_sync_data()

        manufacturers = data.get("manufacturers", [])
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
            mkey = mat.get("key", "").upper() or mat.get("name", "PLA").upper()
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
                material_key = (
                    mat_nested.get("key") or mat_nested.get("name") or "PLA"
                ).upper()

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
            manufacturers=manufacturers,
            materials=materials,
            total_filaments=len(filaments),
        )

    # ------------------------------------------------------------------ #
    #  Filamente fuer ausgewaehlte Hersteller
    # ------------------------------------------------------------------ #

    async def fetch_filaments(
        self, manufacturer_ids: list[int]
    ) -> FilamentsByManufacturer:
        """Filamente + Farben fuer die gegebenen Hersteller-IDs laden.

        Filtert die FilamentDB-Daten auf die uebergebenen Manufacturer-IDs
        und reichert jedes Filament mit ``_exists`` und ``_material_key`` an.
        """
        data = await self._fetch_sync_data()

        manufacturers = data.get("manufacturers", [])
        materials = data.get("materials", [])
        all_filaments = data.get("filaments", [])

        mfr_id_set = set(manufacturer_ids)

        # Material-Map
        mat_map: dict[int, str] = {}
        for mat in materials:
            mid = mat.get("id")
            mkey = mat.get("key", "").upper() or mat.get("name", "PLA").upper()
            if mid:
                mat_map[mid] = mkey

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
            ).join(Manufacturer, Filament.manufacturer_id == Manufacturer.id)
        )
        existing_fil_keys: set[tuple[str, str, str]] = set()
        # Index fuer Fuzzy-Lookup: (mfr_name_lower, material_lower) -> [designation, ...]
        existing_by_mfr_mat: dict[tuple[str, str], list[str]] = defaultdict(list)
        for row in existing_fil_result.all():
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

            # Material auflösen
            mat_id_fdb = fil.get("material_id")
            mat_nested = fil.get("material")
            if not mat_id_fdb and isinstance(mat_nested, dict):
                mat_id_fdb = mat_nested.get("id")

            material_key = mat_map.get(mat_id_fdb, "PLA")
            if material_key == "PLA" and isinstance(mat_nested, dict):
                material_key = (
                    mat_nested.get("key") or mat_nested.get("name") or "PLA"
                ).upper()

            fil["_material_key"] = material_key

            # Duplikat-Check: exakt, dann fuzzy
            designation = (fil.get("designation") or "").strip()
            mfr_name = fdb_mfr_id_to_name.get(mfr_id_fdb, "")
            key = (mfr_name.lower(), designation.lower(), material_key.lower())

            if key in existing_fil_keys:
                fil["_exists"] = True
                fil["_match_type"] = "exact"
            else:
                # Fuzzy-Fallback: alle lokalen Filamente desselben Herstellers+Materials
                candidates = existing_by_mfr_mat.get(
                    (mfr_name.lower(), material_key.lower()), []
                )
                best_score = 0.0
                best_name: str | None = None
                for local_desig in candidates:
                    score = _fuzzy_match_score(local_desig, designation)
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
            filaments=filtered_filaments,
            colors=colors,
        )

    # ------------------------------------------------------------------ #
    #  Diff: existierende Filamente mit FDB-Daten vergleichen
    # ------------------------------------------------------------------ #

    # Felder, die verglichen werden (FDB-Feld -> FilaMan-Feld)
    _DIFF_FIELDS: list[tuple[str, str, str]] = [
        # (fdb_key, filaman_attr, label)
        ("designation", "designation", "designation"),
        ("material_subtype", "material_subgroup", "material_subgroup"),
        ("diameter_mm", "diameter_mm", "diameter_mm"),
        ("color_name", "manufacturer_color_name", "manufacturer_color_name"),
        ("nominal_weight_g", "raw_material_weight_g", "raw_material_weight_g"),
        ("price", "price", "price"),
        ("density_g_cm3", "density_g_cm3", "density_g_cm3"),
        ("color_mode", "color_mode", "color_mode"),
    ]

    async def diff_filaments(self, filament_ids: list[int]) -> list[dict[str, Any]]:
        """Vergleiche existierende FilaMan-Filamente mit FDB-Daten.

        Args:
            filament_ids: FDB-IDs der zu vergleichenden Filamente.

        Returns:
            Liste von Dicts mit fdb_id, designation, manufacturer_name,
            changes (Liste von {field, label, old, new}), identical (bool).
        """
        if not filament_ids:
            return []

        data = await self._fetch_sync_data()
        all_filaments = data.get("filaments", [])
        manufacturers = data.get("manufacturers", [])
        materials = data.get("materials", [])
        spool_profiles = data.get("spool_profiles", [])

        # Maps aufbauen
        fdb_mfr_map: dict[int, str] = {
            m["id"]: (m.get("name") or "").strip() for m in manufacturers if m.get("id")
        }
        mat_map: dict[int, str] = {}
        for mat in materials:
            mid = mat.get("id")
            mkey = mat.get("key", "").upper() or mat.get("name", "PLA").upper()
            if mid:
                mat_map[mid] = mkey

        sp_map: dict[int, dict[str, Any]] = {}
        for sp in spool_profiles:
            sp_id = sp.get("id")
            if sp_id:
                sp_map[sp_id] = sp

        # FDB-Filamente indexieren
        id_set = set(filament_ids)
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
            .options(
                selectinload(Filament.manufacturer),
                selectinload(Filament.filament_colors),
            )
            .where(Filament.custom_fields.isnot(None))
        )
        for fil in local_result.scalars().all():
            cf = fil.custom_fields
            if isinstance(cf, dict) and cf.get("filamentdb_id"):
                fid = cf["filamentdb_id"]
                if fid in id_set:
                    local_by_fdb_id[fid] = fil

        # Fallback: Filamente ueber Name+Hersteller+Material matchen
        if len(local_by_fdb_id) < len(fdb_fils):
            missing_ids = id_set - set(local_by_fdb_id.keys())
            all_local_result = await self.db.execute(
                select(Filament).options(
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
                mfr_id_fdb = _resolve_mfr_id(fdb_f)
                mfr_name = fdb_mfr_map.get(mfr_id_fdb, "").lower() if mfr_id_fdb else ""
                designation = (fdb_f.get("designation") or "").lower()
                mat_id = fdb_f.get("material_id")
                mat_nested = fdb_f.get("material")
                if not mat_id and isinstance(mat_nested, dict):
                    mat_id = mat_nested.get("id")
                material = mat_map.get(mat_id, "PLA").lower()
                if material == "pla" and isinstance(mat_nested, dict):
                    material = (
                        mat_nested.get("key") or mat_nested.get("name") or "PLA"
                    ).lower()

                # Exakter Match
                matched = local_index.get((mfr_name, designation, material))
                if matched:
                    local_by_fdb_id[fdb_id] = matched
                    continue

                # Fuzzy-Fallback
                fdb_desig_raw = (fdb_f.get("designation") or "").strip()
                candidates = local_by_mfr_mat.get((mfr_name, material), [])
                best_score = 0.0
                best_fil: Filament | None = None
                for local_desig, local_fil in candidates:
                    score = _fuzzy_match_score(local_desig, fdb_desig_raw)
                    if score > best_score:
                        best_score = score
                        best_fil = local_fil
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

            # SpoolProfile-Felder vergleichen
            sp_nested = fdb_f.get("spool_profile")
            sp_id = None
            if isinstance(sp_nested, dict):
                sp_id = sp_nested.get("id")
            elif fdb_f.get("spool_profile_id"):
                sp_id = fdb_f["spool_profile_id"]

            sp_data = sp_map.get(sp_id) if sp_id else None
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
                    "designation": designation,
                    "manufacturer_name": mfr_name,
                    "changes": changes,
                    "identical": len(changes) == 0,
                }
            )

        return results

    # ------------------------------------------------------------------ #
    #  Vorschau (komplett — wird intern von execute() genutzt)
    # ------------------------------------------------------------------ #

    async def preview(self) -> ImportPreview:
        """Vorschau: welche Daten wuerden importiert?

        Fuegt jedem Manufacturer und Filament ein ``_exists``-Flag hinzu,
        das anzeigt, ob der Eintrag bereits in der lokalen DB vorhanden ist.
        Manufacturers bekommen zusaetzlich ``_filament_count`` und
        ``_material_types`` fuer die UI.
        """
        data = await self._fetch_sync_data()

        manufacturers = data.get("manufacturers", [])
        materials = data.get("materials", [])
        filaments = data.get("filaments", [])
        spool_profiles = data.get("spool_profiles", [])
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
            mkey = mat.get("key", "").upper() or mat.get("name", "PLA").upper()
            if mid:
                mat_map[mid] = mkey

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
            ).join(Manufacturer, Filament.manufacturer_id == Manufacturer.id)
        )
        existing_fil_keys: set[tuple[str, str, str]] = {
            (
                (row[2] or "").lower(),
                (row[0] or "").lower(),
                (row[1] or "").lower(),
            )
            for row in existing_fil_result.all()
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
                material_key = (
                    mat_nested.get("key") or mat_nested.get("name") or "PLA"
                ).upper()

            fil["_material_key"] = material_key

            # Zaehler / Material-Sets pro Manufacturer
            if mfr_id_fdb:
                mfr_filament_counts[mfr_id_fdb] = (
                    mfr_filament_counts.get(mfr_id_fdb, 0) + 1
                )
                mfr_material_types.setdefault(mfr_id_fdb, set()).add(material_key)

            # Duplikat-Check
            designation = (fil.get("designation") or "").strip()
            mfr_name = fdb_mfr_id_to_name.get(mfr_id_fdb, "") if mfr_id_fdb else ""
            key = (mfr_name.lower(), designation.lower(), material_key.lower())
            fil["_exists"] = key in existing_fil_keys

        # Manufacturers anreichern
        for mfr in manufacturers:
            fdb_id = mfr.get("id")
            mfr["_filament_count"] = mfr_filament_counts.get(fdb_id, 0)
            mfr["_material_types"] = sorted(mfr_material_types.get(fdb_id, set()))

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
        manufacturer_ids: list[int] | None = None,
        filament_ids: list[int] | None = None,
        update_filament_ids: list[int] | None = None,
        skip_fuzzy_ids: list[int] | None = None,
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
        """
        result = ImportResult()
        preview = await self.preview()

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
    ) -> dict[int, int]:
        """Filamente importieren. Gibt FilamentDB-ID -> FilaMan-ID."""
        fil_map: dict[int, int] = {}
        update_id_set = set(update_filament_ids) if update_filament_ids else set()
        skip_fuzzy_set = set(skip_fuzzy_ids) if skip_fuzzy_ids else set()

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

            # Duplicate-Check: exakt, dann fuzzy
            existing = await self.db.execute(
                select(Filament).where(
                    (Filament.manufacturer_id == filaman_mfr_id)
                    & (func.lower(Filament.designation) == designation.lower())
                    & (func.lower(Filament.material_type) == material_key.lower())
                )
            )
            existing_fil = existing.scalar_one_or_none()

            # Fuzzy-Fallback wenn kein exakter Match
            if not existing_fil and fdb_id not in skip_fuzzy_set:
                fuzzy_candidates_result = await self.db.execute(
                    select(Filament).where(
                        (Filament.manufacturer_id == filaman_mfr_id)
                        & (func.lower(Filament.material_type) == material_key.lower())
                    )
                )
                best_score = 0.0
                best_candidate: Filament | None = None
                for candidate in fuzzy_candidates_result.scalars().all():
                    score = _fuzzy_match_score(candidate.designation or "", designation)
                    if score > best_score:
                        best_score = score
                        best_candidate = candidate
                if best_score >= FUZZY_THRESHOLD and best_candidate is not None:
                    existing_fil = best_candidate

            if existing_fil:
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
                    cf = existing_fil.custom_fields or {}
                    cf["filamentdb_id"] = fdb_id
                    existing_fil.custom_fields = cf
                    await self.db.flush()
                    result.filaments_updated += 1
                else:
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
        existing.material_type = material_key
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
        existing.density_g_cm3 = (
            fil_data.get("density_g_cm3")
            if fil_data.get("density_g_cm3") is not None
            else existing.density_g_cm3
        )
        existing.color_mode = fil_data.get("color_mode", existing.color_mode)
        existing.multi_color_style = (
            fil_data.get("multi_color_style") or existing.multi_color_style
        )

        # SpoolProfile-Daten
        if spool_detail_target in ("filament", "both"):
            sp_nested = fil_data.get("spool_profile")
            sp_id = None
            if isinstance(sp_nested, dict):
                sp_id = sp_nested.get("id")
            elif fil_data.get("spool_profile_id"):
                sp_id = fil_data["spool_profile_id"]

            sp_data = spool_profile_map.get(sp_id) if sp_id else None
            if sp_data:
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
        custom = existing.custom_fields or {}
        sku = fil_data.get("sku")
        if sku:
            custom["sku"] = sku
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
