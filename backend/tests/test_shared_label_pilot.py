"""Real authenticated API fixtures for the browser/Node renderer parity check."""
import asyncio
import base64
import copy
import hashlib
import io
import json
import os
import platform
import subprocess
from datetime import UTC, datetime
from pathlib import Path

import pytest
from PIL import Image
from sqlalchemy import select

from app.api.v1 import labels
from app.models import (
    Filament,
    LabelAsset,
    LabelPreset,
    Manufacturer,
    Spool,
    SpoolStatus,
)
from app.models.label_preset import label_preset_name_key


@pytest.mark.asyncio
async def test_shared_api_parity_fixtures(auth_client, db_session, admin_user, monkeypatch):
    client, _ = auth_client
    manufacturer = Manufacturer(name='Bambu Lab')
    db_session.add(manufacturer)
    await db_session.flush()
    filament = Filament(manufacturer_id=manufacturer.id, designation='Matte - Charcoal (11101)',
                        material_type='PLA', diameter_mm=1.75, manufacturer_color_name='Charcoal (11101)', finish_type='Matte')
    db_session.add(filament)
    await db_session.flush()
    status = await db_session.scalar(select(SpoolStatus).where(SpoolStatus.key == 'active'))
    spool = Spool(filament_id=filament.id, status_id=status.id, remaining_weight_g=432,
                  empty_spool_weight_g=250, custom_fields={'article_number': '11101'},
                  created_at=datetime(2026, 10, 5, 22, 16, 10, tzinfo=UTC))
    db_session.add(spool)
    content = io.BytesIO()
    Image.new('RGBA', (80, 50), (30, 150, 200, 170)).save(content, format='PNG')
    content = content.getvalue()
    asset_id = '12345678-1234-1234-1234-123456789abc'
    db_session.add(LabelAsset(id=asset_id, user_id=admin_user.id, display_name='Owned fixture.png',
                             sha256=hashlib.sha256(content).hexdigest(), media_type='image/png',
                             width=80, height=50, byte_size=len(content), content=content))
    design = {'version': 2, 'label': {'widthMm': 40, 'heightMm': 30, 'marginMm': 1, 'border': False}, 'elements': [
        {'id': 'text', 'type': 'text', 'x': 1, 'y': 1, 'w': 38, 'h': 9, 'z': 0, 'fontSizeMm': 2,
         'fontFamily': 'Space Grotesk', 'wrap': True, 'fitToWidth': True, 'minFontSizeMm': 1.5,
         'template': '{filament.name}\n[font=Fraunces]Grüße[/font] [font=Space Mono]ÄÖÜß[/font] [font=Roboto Condensed][b]Füße[/b][/font]'},
        {'id': 'photo', 'type': 'image', 'assetId': asset_id, 'x': 1, 'y': 12, 'w': 15, 'h': 12, 'z': 1},
        {'id': 'boundary', 'type': 'shape', 'shape': 'rectangle', 'x': 1, 'y': 26, 'w': 10, 'h': 2, 'z': 1, 'fill': '#02e57f', 'strokeWidthMm': 0},
        {'id': 'qr', 'type': 'qr', 'x': 20, 'y': 11, 'w': 18, 'h': 18, 'z': 2, 'mode': 'colorLogo'},
    ]}
    preset = LabelPreset(user_id=admin_user.id, preset_type='spool', name='Parity', name_key=label_preset_name_key('Parity'),
                         data={'version': 2, 'design': design})
    db_session.add(preset)
    await db_session.commit()
    original_render = labels.render_svg_png
    captured = {}

    async def capture(payload, origin, assets):
        captured.clear()
        captured.update(payload=payload, origin=origin, assets={})
        for key, value in assets.items():
            with Image.open(io.BytesIO(value)) as image:
                captured['assets'][key] = {'width': image.width, 'height': image.height,
                                          'dataUrl': 'data:image/png;base64,' + base64.b64encode(value).decode()}
        png = await original_render(payload, origin, assets)
        with Image.open(io.BytesIO(png)) as image:
            captured['rgba'] = base64.b64encode(image.convert('RGBA').tobytes()).decode()
        return png

    monkeypatch.setattr(labels, 'render_svg_png', capture)
    rows = []
    for dpi, output, threshold, orientation, align in [
        (203, 'mono1', 200, 'original', 'left'), (300, 'mono1', 150, 'portrait', 'right'),
        (203, 'png', 200, 'original', 'right'), (100, 'png', 0, 'original', 'left'),
        (600, 'png', 255, 'landscape', 'right'), (203, 'mono1', 0, 'original', 'right'),
        (300, 'mono1', 255, 'original', 'left'),
    ]:
        width = 1023 if dpi == 600 else 481
        response = await client.get(f'/api/v1/labels/spool/{spool.id}/render', params={
            'preset_id': preset.id, 'width': width, 'dpi': dpi, 'format': output, 'threshold': threshold,
            'orientation': orientation, 'align': align, 'color': 'color' if output == 'png' else 'mono'})
        assert response.status_code == 200, response.text
        assert 'x-renderer' not in response.headers
        assert 'no-store' in response.headers['cache-control']
        row = {**copy.deepcopy(captured), 'name': 'mixed', 'dpi': dpi, 'format': output, 'threshold': threshold,
               'align': align, 'status': response.status_code, 'headers': dict(response.headers),
               'wire': base64.b64encode(response.content).decode()}
        if output == 'png':
            with Image.open(io.BytesIO(response.content)) as image:
                row['wireRgba'] = base64.b64encode(image.convert('RGBA').tobytes()).decode()
        rows.append(row)
    if evidence := os.environ.get('LABEL_EVIDENCE_DIR'):
        directory = Path(evidence)
        directory.mkdir(parents=True, exist_ok=True)
        (directory / 'api-parity.json').write_text(json.dumps({'architecture': platform.machine(),
            'node': (await asyncio.to_thread(subprocess.check_output, [os.environ.get('LABEL_RENDER_NODE_EXECUTABLE', 'node'), '--version'], text=True)).strip(),
            'cases': rows}))
