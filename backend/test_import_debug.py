"""Debug-Script für Spoolman-Import."""
import asyncio
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from app.core.database import async_session_maker
from app.services.spoolman_import_service import SpoolmanImportService


async def test_import():
    """Testet den Spoolman-Import direkt."""
    print("=" * 60)
    print("Spoolman Import Debug Test")
    print("=" * 60)
    
    # Spoolman URL eingeben
    SPOOLMAN_URL = input("Spoolman URL (z.B. http://192.168.1.100:7912): ").strip()
    
    if not SPOOLMAN_URL:
        print("Keine URL eingegeben. Abbruch.")
        return
    
    async with async_session_maker() as db:
        service = SpoolmanImportService(db)
        
        try:
            print(f"\n1. Teste Verbindung zu {SPOOLMAN_URL}...")
            info = await service.test_connection(SPOOLMAN_URL)
            print(f"   Verbindung erfolgreich! Version: {info.get('version', 'unbekannt')}")
            
        except Exception as e:
            print(f"\nFEHLER bei Verbindungstest: {e}")
            import traceback
            traceback.print_exc()
            return
        
        try:
            print(f"\n2. Lade Vorschau...")
            preview = await service.preview(SPOOLMAN_URL)
            print(f"   Vendors: {len(preview.vendors)}")
            print(f"   Filamente: {len(preview.filaments)}")
            print(f"   Spulen: {len(preview.spools)}")
            print(f"   Locations: {len(preview.locations)}")
            
            # Zeige erste Filamente
            if preview.filaments:
                print("\n   Erste 3 Filamente:")
                for i, f in enumerate(preview.filaments[:3]):
                    print(f"     {i+1}. {f.get('name', '?')} - {f.get('material', '?')}")
        
        except Exception as e:
            print(f"\nFEHLER bei Vorschau: {e}")
            import traceback
            traceback.print_exc()
            return
        
        try:
            print(f"\n3. Führe Import aus...")
            result = await service.execute(SPOOLMAN_URL)
            
            print(f"\n   === ERGEBNIS ===")
            print(f"   Manufacturers erstellt: {result.manufacturers_created}")
            print(f"   Manufacturers übersprungen: {result.manufacturers_skipped}")
            print(f"   Filamente erstellt: {result.filaments_created}")
            print(f"   Filamente übersprungen: {result.filaments_skipped}")
            print(f"   Spulen erstellt: {result.spools_created}")
            print(f"   Spulen übersprungen: {result.spools_skipped}")
            
            if result.errors:
                print(f"\n   === FEHLER ===")
                for err in result.errors[:10]:
                    print(f"   - {err}")
            
            if result.warnings:
                print(f"\n   === WARNUNGEN ===")
                for warn in result.warnings[:10]:
                    print(f"   - {warn}")
            
            print("\n   Import erfolgreich abgeschlossen!")
            
        except Exception as e:
            print(f"\nFEHLER beim Import: {e}")
            import traceback
            traceback.print_exc()
            return


if __name__ == "__main__":
    asyncio.run(test_import())
