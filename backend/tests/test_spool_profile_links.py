from copy import deepcopy

import pytest

from app.services.spool_profile_links import preserve_spool_profile_links


def inventory(filament_id=3, name='Jade White', **extra):
    return {'manufacturers': [{'id': 1, 'name': 'Bambu Lab'}], 'filaments': [{
        'id': filament_id, 'manufacturer_id': 1, 'designation': name,
        'material_type': 'PLA Basic', 'diameter_mm': 1.75,
        'default_spool_weight_g': 250, **extra,
    }]}


def colored_inventory(filament_id=3, color_ids=(5,), hex_codes=('#FF0000',), **extra):
    data = inventory(filament_id, name='PLA Basic', color_mode='multi',
                     multi_color_style='co-extruded', **extra)
    # Inventory backups use database column names, including "type".
    row = data['filaments'][0]
    row['type'] = row.pop('material_type')
    data['colors'] = [
        {'id': color_id, 'name': f'Color {color_id}', 'hex_code': hex_code}
        for color_id, hex_code in zip(color_ids, hex_codes, strict=True)
    ]
    data['filament_colors'] = [
        {'id': position, 'filament_id': filament_id, 'color_id': color_id, 'position': position}
        for position, color_id in enumerate(color_ids, 1)
    ]
    return data


def test_refresh_matches_actual_serialized_inventory_column_names():
    from app.api.v1.system import _serialize_row
    from app.models.filament import Filament

    previous = inventory(filamentdb_spool_profile_id=732)
    previous['filaments'] = [_serialize_row(Filament(**previous['filaments'][0]))]
    incoming = inventory(99)
    incoming['filaments'] = [_serialize_row(Filament(**incoming['filaments'][0]))]
    assert incoming['filaments'][0]['type'] == 'PLA Basic'
    assert 'material_type' not in incoming['filaments'][0]
    assert preserve_spool_profile_links(incoming, previous) == 1
    assert incoming['filaments'][0]['filamentdb_spool_profile_id'] == 732


@pytest.mark.parametrize('material_key', ['type', 'material_type'])
@pytest.mark.parametrize('conflict', ['hex_code', 'position', 'color_mode', 'multi_color_style'])
def test_refresh_rejects_known_backup_color_conflicts(material_key, conflict):
    previous = colored_inventory(color_ids=(5, 6), hex_codes=('#FF0000', '#0000FF'),
                                 filamentdb_spool_profile_id=732)
    incoming = colored_inventory(99, color_ids=(15, 16), hex_codes=('#FF0000', '#0000FF'))
    if material_key == 'material_type':
        for data in (previous, incoming):
            row = data['filaments'][0]
            row['material_type'] = row.pop('type')
    if conflict == 'hex_code':
        incoming['colors'][0]['hex_code'] = '#0000FF'
    elif conflict == 'position':
        incoming['filament_colors'][0]['position'] = 2
        incoming['filament_colors'][1]['position'] = 1
    else:
        incoming['filaments'][0][conflict] = 'single' if conflict == 'color_mode' else 'gradient'
    before, expected = deepcopy(previous), deepcopy(incoming)
    assert preserve_spool_profile_links(incoming, previous) == 0
    assert incoming == expected
    assert previous == before


def test_refresh_matches_color_contents_despite_renumbered_ids_and_backup_row_order():
    previous = colored_inventory(color_ids=(5, 6), hex_codes=('#FF0000', '#0000FF'),
                                 filamentdb_spool_profile_id=732)
    incoming = colored_inventory(99, color_ids=(16, 15), hex_codes=('#f00', '#0000ff'),
                                 default_spool_weight_g=247, spool_width_mm=64)
    incoming['colors'].reverse()
    incoming['filament_colors'].reverse()
    before, expected = deepcopy(previous), deepcopy(incoming)
    expected['filaments'][0]['filamentdb_spool_profile_id'] = 732
    assert preserve_spool_profile_links(incoming, previous) == 1
    assert incoming == expected
    assert previous == before


@pytest.mark.parametrize('missing_from_previous', [False, True])
@pytest.mark.parametrize('missing', ['colors', 'filament_colors'])
def test_refresh_missing_backup_color_information_does_not_invent_conflicts(missing_from_previous, missing):
    previous = colored_inventory(filamentdb_spool_profile_id=732)
    incoming = colored_inventory(99, color_ids=(15,))
    (previous if missing_from_previous else incoming).pop(missing)
    assert preserve_spool_profile_links(incoming, previous) == 1
    assert incoming['filaments'][0]['filamentdb_spool_profile_id'] == 732


@pytest.mark.parametrize('external', [{'filamentdb_id': 47}, {'spoolman_external_id': 'stable-product'}])
def test_refresh_shared_external_identity_overrides_backup_color_conflicts(external):
    previous = colored_inventory(custom_fields=external, filamentdb_spool_profile_id=732)
    incoming = colored_inventory(99, color_ids=(15,), hex_codes=('#0000FF',), custom_fields=external)
    incoming['filaments'][0].update(color_mode='single', multi_color_style='gradient')
    assert preserve_spool_profile_links(incoming, previous) == 1
    assert incoming['filaments'][0]['filamentdb_spool_profile_id'] == 732


def test_refresh_restores_unique_product_link_despite_renumbered_ids_without_changing_measurements():
    previous = inventory(filamentdb_spool_profile_id=732, filamentdb_spool_image_file='732.png',
                         spool_outer_diameter_mm=200, spool_width_mm=65)
    before = deepcopy(previous)
    incoming = inventory(99, default_spool_weight_g=247, spool_outer_diameter_mm=199, spool_width_mm=64)
    expected = deepcopy(incoming)
    assert preserve_spool_profile_links(incoming, previous) == 1
    expected['filaments'][0].update(filamentdb_spool_profile_id=732, filamentdb_spool_image_file='732.png')
    assert incoming == expected
    assert previous == before


@pytest.mark.parametrize('field,old_value,new_value', [
    ('manufacturer_sku', 'RED-1000', 'BLUE-250'),
    ('manufacturer_color_name', 'Red', 'Blue'),
    ('raw_material_weight_g', 1000, 250),
])
def test_refresh_rejects_product_fallback_with_conflicting_known_identity(field, old_value, new_value):
    previous = inventory(**{field: old_value}, filamentdb_spool_profile_id=732,
                         filamentdb_spool_image_file='732.png')
    incoming = inventory(99, **{field: new_value})
    before, expected = deepcopy(previous), deepcopy(incoming)
    assert preserve_spool_profile_links(incoming, previous) == 0
    assert incoming == expected
    assert previous == before


@pytest.mark.parametrize('external', [{'filamentdb_id': 47}, {'spoolman_external_id': 'stable-product'}])
def test_refresh_shared_external_identity_wins_over_changed_product_attributes(external):
    previous = inventory(custom_fields=external, manufacturer_sku='RED-1000',
                         manufacturer_color_name='Red', raw_material_weight_g=1000,
                         filamentdb_spool_profile_id=732, filamentdb_spool_image_file='732.png')
    incoming = inventory(99, custom_fields=external, manufacturer_sku='BLUE-250',
                         manufacturer_color_name='Blue', raw_material_weight_g=250)
    expected = deepcopy(incoming)
    assert preserve_spool_profile_links(incoming, previous) == 1
    expected['filaments'][0].update(filamentdb_spool_profile_id=732, filamentdb_spool_image_file='732.png')
    assert incoming == expected


@pytest.mark.parametrize('missing_from_previous', [False, True])
def test_refresh_product_fallback_allows_missing_identity_attributes(missing_from_previous):
    known = {'manufacturer_sku': 'RED-1000', 'manufacturer_color_name': 'Red', 'raw_material_weight_g': 1000}
    missing = {'manufacturer_sku': None, 'manufacturer_color_name': '', 'raw_material_weight_g': None}
    previous = inventory(**(missing if missing_from_previous else known), filamentdb_spool_profile_id=732)
    incoming = inventory(99, **(known if missing_from_previous else missing))
    expected = deepcopy(incoming)
    assert preserve_spool_profile_links(incoming, previous) == 1
    expected['filaments'][0]['filamentdb_spool_profile_id'] = 732
    assert incoming == expected


def test_refresh_never_uses_database_ids_or_ambiguous_product_names():
    previous = inventory(filamentdb_spool_profile_id=732, filamentdb_spool_image_file='732.png')
    for incoming in [inventory(name='Red'), {'manufacturers': previous['manufacturers'], 'filaments': inventory()['filaments'] * 2}]:
        expected = deepcopy(incoming)
        assert preserve_spool_profile_links(incoming, previous) == 0
        assert incoming == expected
    previous['filaments'] *= 2
    assert preserve_spool_profile_links(inventory(), previous) == 0


def test_refresh_preserves_source_choices_and_only_copies_valid_link_fields():
    previous = inventory(filamentdb_spool_profile_id=732, filamentdb_spool_image_file='732.png')
    incoming = inventory(filamentdb_spool_profile_id=735, filamentdb_spool_image_file='735.png')
    expected = deepcopy(incoming)
    assert preserve_spool_profile_links(incoming, previous) == 0
    assert incoming == expected
    unsafe = inventory(filamentdb_spool_profile_id=-1, filamentdb_spool_image_file='../bad.png')
    assert preserve_spool_profile_links(inventory(), unsafe) == 0


def test_refresh_can_match_a_stable_external_identity_after_product_renaming():
    previous = inventory(custom_fields={'spoolman_external_id': 'bambulab_pla_jadewhite_1000_175_n'}, filamentdb_spool_profile_id=732)
    incoming = inventory(99, name='Jade White renamed', custom_fields=previous['filaments'][0]['custom_fields'])
    assert preserve_spool_profile_links(incoming, previous) == 1


def test_refresh_uses_namespaced_filamandb_identity_after_product_renaming():
    previous = inventory(custom_fields={'filamentdb_id': 47}, filamentdb_spool_profile_id=732)
    incoming = inventory(99, name='Renamed Jade', custom_fields={'filamentdb_id': 47})
    assert preserve_spool_profile_links(incoming, previous) == 1


def test_merge_command_writes_a_private_new_backup_and_never_replaces_existing_files(tmp_path):
    import json
    import stat
    import subprocess
    import sys
    from pathlib import Path

    old = tmp_path / 'old.json'
    incoming = tmp_path / 'incoming.json'
    output = tmp_path / 'merged.json'
    old.write_text(json.dumps({'data': inventory(filamentdb_spool_profile_id=732)}))
    incoming.write_text(json.dumps({'data': inventory()}))
    original = incoming.read_bytes()
    command = [sys.executable, '-m', 'app.services.spool_profile_links', str(old), str(incoming), str(output)]
    result = subprocess.run(command, check=False, cwd=Path(__file__).parents[1], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
    assert json.loads(output.read_text())['data']['filaments'][0]['filamentdb_spool_profile_id'] == 732
    assert stat.S_IMODE(output.stat().st_mode) == 0o600
    assert incoming.read_bytes() == original
    merged = output.read_bytes()
    assert subprocess.run(command, check=False, cwd=Path(__file__).parents[1], capture_output=True).returncode != 0
    assert output.read_bytes() == merged


def test_refresh_uses_shared_identity_when_local_catalog_enrichment_is_missing_from_source():
    previous = inventory(custom_fields={'filamentdb_id': 47, 'spoolman_external_id': 'bambu_white'}, filamentdb_spool_profile_id=732)
    incoming = inventory(99, name='Renamed white', custom_fields={'spoolman_external_id': 'bambu_white'})
    assert preserve_spool_profile_links(incoming, previous) == 1
    # Same human name cannot override an explicitly conflicting external identity.
    conflict = inventory(custom_fields={'filamentdb_id': 48, 'spoolman_external_id': 'bambu_white'})
    assert preserve_spool_profile_links(conflict, previous) == 0


def test_refresh_does_not_copy_one_old_link_to_two_incoming_records_via_different_keys():
    previous = inventory(custom_fields={'filamentdb_id': 47, 'spoolman_external_id': 'bambu_white'}, filamentdb_spool_profile_id=732)
    incoming = inventory(custom_fields={'filamentdb_id': 47})
    incoming['filaments'] += inventory(99, custom_fields={'spoolman_external_id': 'bambu_white'})['filaments']
    expected = deepcopy(incoming)
    assert preserve_spool_profile_links(incoming, previous) == 0
    assert incoming == expected
