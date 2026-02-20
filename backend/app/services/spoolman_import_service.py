"""Spoolman-Import-Service: Daten aus einer Spoolman-Instanz importieren."""

import logging
from dataclasses import dataclass, field
from typing import Any

import httpx
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.filament import Color, Filament, FilamentColor, Manufacturer
from app.models.location import Location
from app.models.spool import Spool, SpoolStatus

logger = logging.getLogger(__name__)

# Standard-Timeout fuer HTTP-Requests
HTTP_TIMEOUT = 30.0


class SpoolmanImportError(Exception):
    """Fehler beim Spoolman-Import."""

    def __init__(self, message: str, code: str = "import_error"):
        super().__init__(message)
        self.code = code


@dataclass
class ImportPreview:
    """Vorschau der zu importierenden Daten."""

    vendors: list[dict[str, Any]] = field(default_factory=list)
    filaments: list[dict[str, Any]] = field(default_factory=list)
    spools: list[dict[str, Any]] = field(default_factory=list)
    locations: list[dict[str, Any]] = field(default_factory=list)
    colors: list[dict[str, str]] = field(default_factory=list)

    @property
    def summary(self) -> dict[str, int]:
        return {
            "vendors": len(self.vendors),
            "filaments": len(self.filaments),
            "spools": len(self.spools),
            "locations": len(self.locations),
            "colors": len(self.colors),
        }


@dataclass
class ImportResult:
    """Ergebnis des Imports."""

    manufacturers_created: int = 0
    manufacturers_skipped: int = 0
    locations_created: int = 0
    locations_skipped: int = 0
    colors_created: int = 0
    colors_skipped: int = 0
    filaments_created: int = 0
    filaments_skipped: int = 0
    spools_created: int = 0
    spools_skipped: int = 0
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


class SpoolmanImportService:
    """Service fuer den Import aus einer Spoolman-Instanz."""

    def __init__(self, db: AsyncSession):
        self.db = db

    # ------------------------------------------------------------------ #
    #  Verbindungstest
    # ------------------------------------------------------------------ #

    async def test_connection(self, base_url: str) -> dict[str, Any]:
        """Verbindung zu Spoolman testen.

        Gibt Spoolman-Info zurueck (Version etc.).
        """
        base_url = base_url.rstrip("/")

        # Timeout für Verbindungstest
        async with httpx.AsyncClient(timeout=10.0) as client:
            try:
                # Try /api/v1/info first, fall back to /api/v1/health
                try:
                    resp = await client.get(f"{base_url}/api/v1/info")
                    if resp.status_code == 404:
                        resp = await client.get(f"{base_url}/api/v1/health")
                except httpx.RequestError as e:
                    raise SpoolmanImportError(
                        f"Verbindung zu '{base_url}' fehlgeschlagen: {e}",
                        "connection_failed",
                    )

                if resp.status_code != 200:
                    raise SpoolmanImportError(
                        f"Spoolman antwortet mit Status {resp.status_code}",
                        "connection_failed",
                    )

                try:
                    data = resp.json()
                except Exception:
                    raise SpoolmanImportError(
                        "Ungültige JSON-Antwort von Spoolman",
                        "invalid_response",
                    )

                return {
                    "status": "ok",
                    "url": base_url,
                    "info": data,
                }
            except httpx.TimeoutException:
                raise SpoolmanImportError(
                    f"Timeout bei Verbindung zu '{base_url}'",
                    "connection_timeout",
                )
            except SpoolmanImportError:
                raise
            except Exception as e:
                raise SpoolmanImportError(
                    f"Fehler beim Verbindungstest: {e}",
                    "connection_error",
                )

    # ------------------------------------------------------------------ #
    #  Daten von Spoolman abrufen
    # ------------------------------------------------------------------ #

    async def _fetch_all(self, client: httpx.AsyncClient, base_url: str, endpoint: str, extra_params: dict[str, Any] | None = None) -> list[dict[str, Any]]:
        """Alle Eintraege eines Spoolman-Endpoints abrufen (mit Pagination)."""
        results: list[dict[str, Any]] = []
        limit = 50  # Reduziertes Limit um Timeouts bei großen Payloads zu vermeiden
        offset = 0

        while True:
            params = {"limit": limit, "offset": offset}
            if extra_params:
                params.update(extra_params)
                
            try:
                resp = await client.get(
                    f"{base_url}/api/v1/{endpoint}",
                    params=params,
                )
            except httpx.TimeoutException:
                raise SpoolmanImportError(
                    f"Timeout beim Abrufen von /{endpoint} (Offset {offset})",
                    "fetch_timeout",
                )
            except httpx.RequestError as e:
                raise SpoolmanImportError(
                    f"Netzwerkfehler beim Abrufen von /{endpoint}: {e}",
                    "fetch_network_error",
                )

            if resp.status_code != 200:
                # Versuche Fehlermeldung aus Body zu lesen
                try:
                    err_body = resp.text[:200]
                except Exception:
                    err_body = "n/a"
                
                raise SpoolmanImportError(
                    f"Fehler beim Abrufen von /{endpoint}: Status {resp.status_code}. Response: {err_body}",
                    "fetch_error",
                )

            try:
                batch = resp.json()
            except Exception:
                 raise SpoolmanImportError(
                    f"Ungültige JSON-Antwort von /{endpoint}",
                    "invalid_json",
                )

            # Sicherheitscheck: Spoolman muss eine Liste zurueckgeben
            if not isinstance(batch, list):
                # Manche Endpoints geben vielleicht kein Array zurück? 
                # Falls es ein Dictionary ist, verpacken wir es in eine Liste (falls sinnvoll) 
                # oder werfen Fehler. Spoolman list endpoints sollten Listen sein.
                raise SpoolmanImportError(
                    f"Unerwartete Antwort von /{endpoint}: Liste erwartet, aber {type(batch).__name__} erhalten.",
                    "invalid_response_format",
                )
                
            if not batch:
                break

            results.extend(batch)

            if len(batch) < limit:
                break
            offset += limit

        return results

    # ------------------------------------------------------------------ #
    #  Vorschau
    # ------------------------------------------------------------------ #

    async def preview(self, base_url: str) -> ImportPreview:
        """Vorschau: Welche Daten wuerden importiert?"""
        base_url = base_url.rstrip("/")

        # Erhöhter Timeout für den Preview-Prozess
        async with httpx.AsyncClient(timeout=60.0) as client:
            params = {"allow_archived": "true"}
            
            # 1. Vendors
            try:
                vendors = await self._fetch_all(client, base_url, "vendor", extra_params=params)
            except Exception as e:
                raise SpoolmanImportError(f"Fehler beim Laden der Hersteller (vendor): {e}")

            # 2. Filaments
            try:
                filaments = await self._fetch_all(client, base_url, "filament", extra_params=params)
            except Exception as e:
                raise SpoolmanImportError(f"Fehler beim Laden der Filamente (filament): {e}")

            # 3. Spools
            try:
                spools = await self._fetch_all(client, base_url, "spool", extra_params=params)
            except Exception as e:
                raise SpoolmanImportError(f"Fehler beim Laden der Spulen (spool): {e}")

            # 4. Locations
            # Locations aus Spools extrahieren (Spoolman hat kein /location Endpoint in allen Versionen)
            # Auch bei Fehlern im Location-Endpoint (z.B. 500 oder falsches Format) Fallback nutzen
            locations = []
            try:
                locations = await self._fetch_all(client, base_url, "location")
            except Exception as e:
                logger.warning(f"Could not fetch locations from endpoint: {e}. Using fallback.")
            
            # Fallback & Supplement: Locations aus Spools extrahieren
            # Spoolman kann Locations als String oder Objekt speichern
            seen_locations: set[str] = {
                str(l.get("name")).strip() for l in locations 
                if isinstance(l, dict) and l.get("name")
            }
            
            for spool in spools:
                loc = spool.get("location")
                if not loc:
                    continue

                if isinstance(loc, dict):
                    loc_name = loc.get("name", "").strip()
                    if loc_name and loc_name not in seen_locations:
                        seen_locations.add(loc_name)
                        locations.append(loc)
                elif isinstance(loc, str):
                    loc_name = loc.strip()
                    if loc_name and loc_name not in seen_locations:
                        seen_locations.add(loc_name)
                        # Pseudo-Objekt erstellen für den Import
                        locations.append({"name": loc_name})

        # Farben aus Filamenten extrahieren
        try:
            colors = self._extract_colors(filaments)
        except Exception as e:
             raise SpoolmanImportError(f"Fehler beim Extrahieren der Farben: {e}")

        return ImportPreview(
            vendors=vendors,
            filaments=filaments,
            spools=spools,
            locations=locations,
            colors=colors,
        )

    def _extract_colors(self, filaments: list[dict[str, Any]]) -> list[dict[str, str]]:
        """Eindeutige Farben aus Spoolman-Filamenten extrahieren."""
        seen: set[str] = set()
        colors: list[dict[str, str]] = []

        for fil in filaments:
            color_hex = fil.get("color_hex")
            if color_hex:
                hex_code = f"#{color_hex.lstrip('#')}"
                if hex_code.lower() not in seen:
                    seen.add(hex_code.lower())
                    # Farbname: Spoolman hat keinen separaten Farbnamen,
                    # wir nutzen den Hex-Code als Fallback
                    name = hex_code.upper()
                    colors.append({"name": name, "hex_code": hex_code})

            # Multi-Color
            multi = fil.get("multi_color_hexes")
            if multi:
                hex_list = multi if isinstance(multi, list) else str(multi).split(",")
                for h in hex_list:
                    h = h.strip()
                    if h:
                        hex_code = f"#{h.lstrip('#')}"
                        if hex_code.lower() not in seen:
                            seen.add(hex_code.lower())
                            colors.append({"name": hex_code.upper(), "hex_code": hex_code})

        return colors

    # ------------------------------------------------------------------ #
    #  Import ausfuehren
    # ------------------------------------------------------------------ #

    async def execute(self, base_url: str) -> ImportResult:
        """Vollstaendigen Import aus Spoolman ausfuehren."""
        result = ImportResult()
        preview = await self.preview(base_url)

        # 1. Spool-Status-Mapping laden
        status_map = await self._load_status_map()

        # 2. Locations importieren
        location_map, name_map = await self._import_locations(preview.locations, result)

        # 3. Manufacturers importieren
        manufacturer_map = await self._import_manufacturers(preview.vendors, result)

        # 4. Colors importieren
        color_map = await self._import_colors(preview.colors, result)

        # 5. Filaments importieren
        filament_map = await self._import_filaments(
            preview.filaments, manufacturer_map, color_map, result
        )

        # 6. Spools importieren
        await self._import_spools(
            preview.spools, filament_map, location_map, name_map, status_map, result
        )

        await self.db.commit()

        logger.info(
            f"Spoolman-Import abgeschlossen: "
            f"{result.manufacturers_created} Hersteller, "
            f"{result.filaments_created} Filamente, "
            f"{result.spools_created} Spulen, "
            f"{result.locations_created} Standorte, "
            f"{result.colors_created} Farben"
        )

        return result

    # ------------------------------------------------------------------ #
    #  Hilfs-Methoden fuer den Import
    # ------------------------------------------------------------------ #

    async def _load_status_map(self) -> dict[str, int]:
        """Spool-Status-Mapping laden (key -> id)."""
        result = await self.db.execute(select(SpoolStatus))
        statuses = result.scalars().all()
        return {s.key: s.id for s in statuses}

    async def _import_locations(
        self, locations: list[dict[str, Any]], result: ImportResult
    ) -> tuple[dict[Any, int], dict[str, int]]:
        """Locations importieren. Gibt (Spoolman-ID -> FilaMan-ID, Name -> FilaMan-ID) zurueck."""
        loc_map: dict[Any, int] = {}
        name_map: dict[str, int] = {}

        for loc_data in locations:
            # Safety Check: Falls loc_data kein Dict ist
            if not isinstance(loc_data, dict):
                continue
                
            spoolman_id = loc_data.get("id")
            name = self._clean(loc_data.get("name"))
            
            # Fallback name if missing but ID exists
            if not name and spoolman_id:
                name = f"Spoolman Location #{spoolman_id}"
            
            if not name:
                continue

            # Pruefen ob Location mit gleichem Namen oder Spoolman-ID existiert
            # Wir nutzen json_extract für maximale Kompatibilität (besonders SQLite)
            existing = await self.db.execute(
                select(Location).where(
                    (Location.name == name) |
                    (func.json_extract(Location.custom_fields, '$.spoolman_id') == spoolman_id) |
                    (func.json_extract(Location.custom_fields, '$.spoolman_id') == str(spoolman_id))
                )
            )
            existing_loc = existing.scalar_one_or_none()

            final_id: int
            if existing_loc:
                final_id = existing_loc.id
                result.locations_skipped += 1
            else:
                new_loc = Location(
                    name=name,
                    custom_fields={"spoolman_id": spoolman_id} if spoolman_id else None,
                )
                self.db.add(new_loc)
                await self.db.flush()  # ID erhalten
                final_id = new_loc.id
                result.locations_created += 1

            # Mapping pflegen
            if spoolman_id:
                # Store ID as is
                loc_map[spoolman_id] = final_id
                
                # Try storing int/str variants
                try:
                    loc_map[int(spoolman_id)] = final_id
                except (ValueError, TypeError):
                    pass
                try:
                    loc_map[str(spoolman_id)] = final_id
                except (ValueError, TypeError):
                    pass
            
            # Map name (normalized for better hit rate?)
            name_map[name] = final_id
            # Also map lower case for robust lookup
            name_map[name.lower()] = final_id

        return loc_map, name_map

    async def _import_manufacturers(
        self, vendors: list[dict[str, Any]], result: ImportResult
    ) -> dict[int, int]:
        """Vendors als Manufacturers importieren. Gibt Spoolman-Vendor-ID -> FilaMan-ID."""
        mfr_map: dict[int, int] = {}

        for vendor in vendors:
            # Safety Check
            if not isinstance(vendor, dict):
                continue
                
            spoolman_id = vendor.get("id")
            name = self._clean(vendor.get("name"))
            if not name:
                continue

            # Pruefen ob Manufacturer mit gleichem Namen oder Spoolman-ID existiert
            # Wir nutzen json_extract für maximale Kompatibilität (besonders SQLite)
            existing = await self.db.execute(
                select(Manufacturer).where(
                    (Manufacturer.name == name) |
                    (func.json_extract(Manufacturer.custom_fields, '$.spoolman_id') == spoolman_id) |
                    (func.json_extract(Manufacturer.custom_fields, '$.spoolman_id') == str(spoolman_id))
                )
            )
            existing_mfr = existing.scalar_one_or_none()

            if existing_mfr:
                if spoolman_id:
                    mfr_map[spoolman_id] = existing_mfr.id
                result.manufacturers_skipped += 1
                continue

            # custom_fields fuer Extra-Daten
            custom: dict[str, Any] = {}
            if spoolman_id:
                custom["spoolman_id"] = spoolman_id
            comment = self._clean(vendor.get("comment"))
            if comment:
                custom["comment"] = comment
            extra = vendor.get("extra")
            if extra and isinstance(extra, dict):
                custom["spoolman_extra"] = self._clean_dict(extra)

            new_mfr = Manufacturer(
                name=name,
                url=self._clean(vendor.get("url")),
                custom_fields=custom if custom else None,
            )
            self.db.add(new_mfr)
            await self.db.flush()

            if spoolman_id:
                mfr_map[spoolman_id] = new_mfr.id
            result.manufacturers_created += 1

        return mfr_map

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
            # Safety Check
            if not isinstance(color_data, dict):
                continue

            hex_code = color_data["hex_code"].lower()
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

    async def _import_filaments(
        self,
        filaments: list[dict[str, Any]],
        manufacturer_map: dict[int, int],
        color_map: dict[str, int],
        result: ImportResult,
    ) -> dict[int, int]:
        """Filamente importieren. Gibt Spoolman-Filament-ID -> FilaMan-ID."""
        fil_map: dict[int, int] = {}

        for fil_data in filaments:
            # Safety Check
            if not isinstance(fil_data, dict):
                continue
                
            spoolman_id = fil_data.get("id")

            # Pruefen ob Filament mit dieser Spoolman-ID bereits existiert
            if spoolman_id:
                existing_fil_res = await self.db.execute(
                    select(Filament).where(
                        (func.json_extract(Filament.custom_fields, '$.spoolman_id') == spoolman_id) |
                        (func.json_extract(Filament.custom_fields, '$.spoolman_id') == str(spoolman_id))
                    )
                )
                existing_fil = existing_fil_res.scalar_one_or_none()
                if existing_fil:
                    fil_map[spoolman_id] = existing_fil.id
                    result.filaments_skipped += 1
                    continue

            # Manufacturer auflösen
            vendor = fil_data.get("vendor")
            # Safety: Ensure vendor is a dict
            vendor_id = vendor.get("id") if vendor and isinstance(vendor, dict) else None
            filaman_mfr_id = manufacturer_map.get(vendor_id) if vendor_id else None

            if not filaman_mfr_id:
                # Unbekannter Hersteller - "Unknown" anlegen oder finden
                filaman_mfr_id = await self._get_or_create_unknown_manufacturer()
                result.warnings.append(
                    f"Filament '{fil_data.get('name', '?')}' (ID {spoolman_id}): "
                    "Kein Hersteller zugeordnet, verwende 'Unknown'"
                )

            # Mapping: Spoolman -> FilaMan Felder
            material = self._clean(fil_data.get("material")) or "PLA"
            name = self._clean(fil_data.get("name")) or ""
            designation = name if name else f"{material} (Spoolman #{spoolman_id})"
            diameter = fil_data.get("diameter", 1.75) or 1.75

            # Gewichte
            raw_weight = fil_data.get("weight")  # Net filament weight in g
            spool_weight = fil_data.get("spool_weight")  # Empty spool weight
            # Vendor empty_spool_weight -> filament default_spool_weight_g
            if not spool_weight and vendor and isinstance(vendor, dict):
                spool_weight = vendor.get("empty_spool_weight")

            # Farb-Modus erkennen
            multi_hexes = fil_data.get("multi_color_hexes")
            color_mode = "multi" if multi_hexes else "single"
            multi_color_style = None
            if multi_hexes:
                direction = fil_data.get("multi_color_direction", "")
                if direction == "coaxial":
                    multi_color_style = "gradient"
                else:
                    multi_color_style = "striped"

            # Extra-Felder -> custom_fields
            custom: dict[str, Any] = {}
            if spoolman_id:
                custom["spoolman_id"] = spoolman_id
            fil_comment = self._clean(fil_data.get("comment"))
            if fil_comment:
                custom["comment"] = fil_comment
            article_nr = self._clean(fil_data.get("article_number"))
            if article_nr:
                custom["article_number"] = article_nr
            ext_id = self._clean(fil_data.get("external_id"))
            if ext_id:
                custom["spoolman_external_id"] = ext_id
            if fil_data.get("settings_extruder_temp"):
                custom["settings_extruder_temp"] = fil_data["settings_extruder_temp"]
            if fil_data.get("settings_bed_temp"):
                custom["settings_bed_temp"] = fil_data["settings_bed_temp"]
            # Extra-Dict: bekannte Felder mappen, Rest als spoolman_extra
            extra = fil_data.get("extra")
            if extra and isinstance(extra, dict):
                extracted_keys: set[str] = set()
                # Extruder-Temp aus Extra (falls nicht direkt vorhanden)
                if not fil_data.get("settings_extruder_temp"):
                    et = self._extract_extra(extra, extracted_keys, [
                        "extruder_temp", "nozzle_temp", "print_temp",
                    ])
                    if et:
                        custom["settings_extruder_temp"] = et
                # Bed-Temp aus Extra
                if not fil_data.get("settings_bed_temp"):
                    bt = self._extract_extra(extra, extracted_keys, [
                        "bed_temp", "heatbed_temp",
                    ])
                    if bt:
                        custom["settings_bed_temp"] = bt
                # Restliche Extra-Felder als JSON speichern
                remaining = {k: v for k, v in extra.items()
                             if k not in extracted_keys}
                if remaining:
                    custom["spoolman_extra"] = self._clean_dict(remaining)

            try:
                new_fil = Filament(
                    manufacturer_id=filaman_mfr_id,
                    designation=designation,
                    type=material,
                    diameter_mm=diameter,
                    raw_material_weight_g=raw_weight,
                    default_spool_weight_g=spool_weight,
                    density_g_cm3=fil_data.get("density"),
                    price=fil_data.get("price"),
                    shop_url=self._clean(fil_data.get("article_number")),
                    manufacturer_color_name=self._clean(fil_data.get("color_hex")),
                    color_mode=color_mode,
                    multi_color_style=multi_color_style,
                    custom_fields=custom if custom else None,
                )
                self.db.add(new_fil)
                await self.db.flush()

                if spoolman_id:
                    fil_map[spoolman_id] = new_fil.id

                # Farb-Zuordnungen erstellen
                await self._create_filament_colors(
                    new_fil.id, fil_data, color_map
                )

                result.filaments_created += 1

            except Exception as e:
                result.errors.append(
                    f"Fehler beim Import von Filament '{designation}' "
                    f"(Spoolman ID {spoolman_id}): {e}"
                )
                logger.warning(f"Filament-Import fehlgeschlagen: {e}", exc_info=True)

        return fil_map

    async def _create_filament_colors(
        self,
        filament_id: int,
        fil_data: dict[str, Any],
        color_map: dict[str, int],
    ) -> None:
        """Farb-Zuordnungen fuer ein Filament erstellen."""
        position = 1

        # Hauptfarbe
        color_hex = fil_data.get("color_hex")
        if color_hex:
            hex_key = f"#{color_hex.lstrip('#')}".lower()
            color_id = color_map.get(hex_key)
            if color_id:
                fc = FilamentColor(
                    filament_id=filament_id,
                    color_id=color_id,
                    position=position,
                )
                self.db.add(fc)
                position += 1

        # Multi-Color
        multi = fil_data.get("multi_color_hexes")
        if multi:
            hex_list = multi if isinstance(multi, list) else str(multi).split(",")
            for h in hex_list:
                h = h.strip()
                if h:
                    hex_key = f"#{h.lstrip('#')}".lower()
                    color_id = color_map.get(hex_key)
                    if color_id:
                        fc = FilamentColor(
                            filament_id=filament_id,
                            color_id=color_id,
                            position=position,
                        )
                        self.db.add(fc)
                        position += 1

    async def _import_spools(
        self,
        spools: list[dict[str, Any]],
        filament_map: dict[int, int],
        location_map: dict[Any, int],
        location_name_map: dict[str, int],
        status_map: dict[str, int],
        result: ImportResult,
    ) -> None:
        """Spools importieren."""
        for spool_data in spools:
            spoolman_id = spool_data.get("id")

            # Filament auflösen
            fil = spool_data.get("filament")
            fil_spoolman_id = fil.get("id") if fil and isinstance(fil, dict) else None
            filaman_fil_id = filament_map.get(fil_spoolman_id) if fil_spoolman_id else None

            if not filaman_fil_id:
                result.errors.append(
                    f"Spule Spoolman #{spoolman_id}: "
                    f"Filament (Spoolman #{fil_spoolman_id}) nicht gefunden, uebersprungen"
                )
                result.spools_skipped += 1
                continue

            # Status bestimmen
            is_archived = spool_data.get("archived", False)
            if is_archived:
                status_key = "archived"
            else:
                # Heuristik: remaining_weight bestimmt Status
                remaining = spool_data.get("remaining_weight")
                used = spool_data.get("used_weight", 0)
                if remaining is not None and remaining <= 0:
                    status_key = "empty"
                elif used and used > 0:
                    status_key = "active"
                else:
                    status_key = "new"

            status_id = status_map.get(status_key, status_map.get("active", 1))

            # Location auflösen
            # Location kann ein Objekt {id: 1, name: "Regal"} oder ein String "Regal" sein
            loc = spool_data.get("location")
            location_id = None
            
            if loc:
                if isinstance(loc, dict):
                    loc_spoolman_id = loc.get("id")
                    if loc_spoolman_id is not None:
                        # Try exact match (int)
                        location_id = location_map.get(loc_spoolman_id)
                        # Try string/int conversion mismatch
                        if not location_id:
                             try:
                                 location_id = location_map.get(int(loc_spoolman_id))
                             except (ValueError, TypeError):
                                 pass
                        if not location_id:
                             try:
                                 location_id = location_map.get(str(loc_spoolman_id))
                             except (ValueError, TypeError):
                                 pass

                    # Fallback auf Name, falls ID nicht gefunden (z.B. neu erstellt ohne ID)
                    if not location_id:
                        loc_name = self._clean(loc.get("name"))
                        if loc_name:
                            location_id = location_name_map.get(loc_name)
                            if not location_id:
                                location_id = location_name_map.get(loc_name.lower())
                
                elif isinstance(loc, str):
                    loc_name = self._clean(loc)
                    if loc_name:
                        location_id = location_name_map.get(loc_name)
                        if not location_id:
                             location_id = location_name_map.get(loc_name.lower())

                if not location_id:
                     result.warnings.append(
                         f"Spule Spoolman #{spoolman_id}: Location '{loc}' konnte nicht zugeordnet werden."
                     )

            # Gewichte berechnen

            initial_weight = spool_data.get("initial_weight")  # Net filament
            spool_weight = spool_data.get("spool_weight")
            remaining_weight = spool_data.get("remaining_weight")

            # initial_total_weight_g = filament + spool
            initial_total = None
            if initial_weight is not None:
                initial_total = initial_weight + (spool_weight or 0)

            # Extra-Felder auswerten
            extra = spool_data.get("extra")
            rfid_uid = None
            extracted_keys: set[str] = set()

            if extra and isinstance(extra, dict):
                # RFID / NFC ID extrahieren — Spoolman nennt es "NFC ID"
                rfid_uid = self._extract_extra(extra, extracted_keys, [
                    "nfc_id", "NFC ID", "nfc", "NFC",
                    "rfid_uid", "rfid", "RFID", "rfid_id",
                    "tag_uid", "tag_id", "uid",
                ])

            # external_id: Spoolman-ID als Referenz
            external_id = f"spoolman:{spoolman_id}" if spoolman_id else None

            # Pruefen ob Spule bereits existiert (via external_id oder spoolman_id in custom_fields)
            if spoolman_id:
                dup_check = await self.db.execute(
                    select(Spool).where(
                        (Spool.external_id == external_id) |
                        (func.json_extract(Spool.custom_fields, '$.spoolman_id') == spoolman_id) |
                        (func.json_extract(Spool.custom_fields, '$.spoolman_id') == str(spoolman_id))
                    )
                )
                if dup_check.scalar_one_or_none():
                    result.spools_skipped += 1
                    continue

            # Pruefen ob rfid_uid schon existiert
            if rfid_uid:
                dup_rfid = await self.db.execute(
                    select(Spool).where(Spool.rfid_uid == rfid_uid)
                )
                if dup_rfid.scalar_one_or_none():
                    result.warnings.append(
                        f"Spule Spoolman #{spoolman_id}: RFID '{rfid_uid}' existiert bereits, wird ohne RFID importiert"
                    )
                    rfid_uid = None

            # custom_fields: Spoolman-Meta + ungemappte Extra-Felder
            custom: dict[str, Any] = {}
            if spoolman_id:
                custom["spoolman_id"] = spoolman_id
            spool_comment = self._clean(spool_data.get("comment"))
            if spool_comment:
                custom["comment"] = spool_comment
            if extra and isinstance(extra, dict):
                remaining_extra = {k: v for k, v in extra.items()
                                   if k not in extracted_keys}
                if remaining_extra:
                    custom["spoolman_extra"] = self._clean_dict(remaining_extra)

            # Datums-Felder
            first_used = spool_data.get("first_used")
            last_used = spool_data.get("last_used")

            try:
                # Nested transaction damit ein Fehler nicht den ganzen Import abbricht
                async with self.db.begin_nested():
                    new_spool = Spool(
                        filament_id=filaman_fil_id,
                        status_id=status_id,
                        lot_number=self._clean(spool_data.get("lot_nr")),
                        rfid_uid=rfid_uid,
                        external_id=external_id,
                        location_id=location_id,
                        purchase_price=spool_data.get("price"),
                        initial_total_weight_g=initial_total,
                        empty_spool_weight_g=spool_weight,
                        remaining_weight_g=remaining_weight,
                        custom_fields=custom if custom else None,
                    )
                    self.db.add(new_spool)
                    await self.db.flush()
                
                result.spools_created += 1

            except Exception as e:
                result.errors.append(
                    f"Fehler beim Import von Spule Spoolman #{spoolman_id}: {e}"
                )
                logger.warning(f"Spool-Import fehlgeschlagen: {e}", exc_info=True)

    async def _get_or_create_unknown_manufacturer(self) -> int:
        """'Unknown'-Hersteller finden oder erstellen."""
        existing = await self.db.execute(
            select(Manufacturer).where(Manufacturer.name == "Unknown")
        )
        mfr = existing.scalar_one_or_none()
        if mfr:
            return mfr.id

        new_mfr = Manufacturer(name="Unknown")
        self.db.add(new_mfr)
        await self.db.flush()
        return new_mfr.id

    @staticmethod
    def _clean(value: Any) -> str | None:
        """String-Wert bereinigen: Anführungszeichen, Whitespace etc. entfernen.

        Gibt None zurueck wenn der Wert leer oder kein String ist.
        """
        if value is None:
            return None
        s = str(value).strip().strip('"').strip("'").strip()
        return s if s else None

    @staticmethod
    def _clean_dict(d: dict[str, Any]) -> dict[str, Any]:
        """Alle String-Werte in einem Dict bereinigen (rekursiv)."""
        cleaned: dict[str, Any] = {}
        for k, v in d.items():
            if isinstance(v, str):
                v = v.strip().strip('"').strip("'").strip()
            elif isinstance(v, dict):
                v = SpoolmanImportService._clean_dict(v)
            cleaned[k] = v
        return cleaned

    @staticmethod
    def _extract_extra(
        extra: dict[str, Any],
        extracted: set[str],
        candidate_keys: list[str],
    ) -> str | None:
        """Einen Wert aus dem extra-Dict extrahieren.

        Probiert alle candidate_keys (case-insensitive) und merkt sich den
        gefundenen Key in ``extracted``, damit er spaeter herausgefiltert wird.
        Gibt None zurueck wenn der Wert nach Bereinigung leer ist.
        """
        # Schneller exakter Match
        for key in candidate_keys:
            val = extra.get(key)
            if val is not None:
                cleaned = str(val).strip().strip('"').strip("'").strip()
                if cleaned:
                    extracted.add(key)
                    return cleaned
                # Key merken auch wenn leer (damit er nicht in spoolman_extra landet)
                extracted.add(key)

        # Case-insensitive Fallback
        lower_map = {k.lower().replace(" ", "_"): k for k in extra}
        for key in candidate_keys:
            normalized = key.lower().replace(" ", "_")
            original_key = lower_map.get(normalized)
            if original_key and original_key not in extracted:
                val = extra.get(original_key)
                if val is not None:
                    cleaned = str(val).strip().strip('"').strip("'").strip()
                    if cleaned:
                        extracted.add(original_key)
                        return cleaned
                    extracted.add(original_key)

        return None
