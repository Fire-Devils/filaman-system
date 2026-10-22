// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from 'vitest'
import { experimental_AstroContainer as AstroContainer } from 'astro/container'
import FieldDock from '../../components/freeform-label/FieldDock.astro'
import { renderTemplateText, type SpoolData } from '../label-template'
import { bindFreeformEditorDom } from './editor-dom'
import { createFreeformEditorController } from './editor-state'

// Independent fixtures preserve the former picker's visible labels, order and
// insertion contract; importing the new catalog here would hide missing fields.
const filamentFields = [
  ['{color_swatch[1]}', 'color_swatch', '[[FM_SWATCH|1|layers|#123456]]'],
  ['{id}', 'id', '42'],
  ['{filament.id}', 'filament_id', '8'],
  ['{filament.name}', 'name', 'Galaxy PLA'],
  ['{filament.manufacturer}', 'manufacturer', 'Example Filaments'],
  ['{filament.manufacturer_id}', 'manufacturer_id', '5'],
  ['{filament.type}', 'type', 'PLA'],
  ['{filament.subtype}', 'subtype', 'Silk'],
  ['{filament.manufacturer_color_name}', 'color_name', 'Nebula'],
  ['{filament.color}', 'color', 'Galaxy Blue'],
  ['{filament.colors}', 'colors', 'Galaxy Blue, Purple'],
  ['{filament.color_hex}', 'color_hex', '#123456'],
  ['{filament.color_hexes}', 'color_hexes', '#123456'],
  ['{filament.color_mode}', 'color_mode', 'multi'],
  ['{filament.multi_color_style}', 'multi_color_style', 'gradient'],
  ['{filament.raw_material_weight_g}', 'raw_material_weight_g', '1000'],
  ['{filament.diameter}', 'diameter', '1.75'],
  ['{filament.finish}', 'finish', 'Glossy'],
  ['{filament.density}', 'density', '1.24'],
  ['{filament.price}', 'price', '22.5'],
  ['{filament.default_spool_weight_g}', 'default_spool_wt', '250'],
  ['{filament.spool_outer_diameter_mm}', 'spool_outer_dia', '200'],
  ['{filament.spool_width_mm}', 'spool_width', '65'],
  ['{filament.spool_material}', 'spool_material', 'Cardboard'],
  ['{filament.shop_url}', 'shop_url', 'https://example.test/pla'],
]
const spoolFields = [
  ['{lot_number}', 'lot_number', 'LOT-42'],
  ['{external_id}', 'external_id', 'spoolman:42'],
  ['{rfid_uid}', 'rfid_uid', 'AA:BB'],
  ['{location}', 'location', 'Rack A'],
  ['{status}', 'status', 'Opened'],
  ['{purchase_date}', 'purchase_date', '2026-01-02'],
  ['{purchase_price}', 'purchase_price', '24.95'],
  ['{remaining_weight_g}', 'remaining_weight_g', '712'],
  ['{initial_total_weight_g}', 'initial_weight_g', '1250'],
  ['{empty_spool_weight_g}', 'empty_spool_wt', '250'],
  ['{spool_core_weight_g}', 'spool_core_weight_g', '42'],
  ['{low_weight_threshold_g}', 'low_weight_g', '100'],
  ['{stocked_in_at}', 'stocked_in_at', '2026-01-03'],
  ['{last_used_at}', 'last_used_at', '2026-01-04'],
  ['{created_at}', 'created_at', '2026-01-01'],
]

const data: SpoolData = {
  id: 42,
  'filament.id': '8',
  'filament.name': 'Galaxy PLA',
  'filament.manufacturer': 'Example Filaments',
  'filament.manufacturer_id': '5',
  'filament.material': 'PLA',
  'filament.type': 'PLA',
  'filament.subtype': 'Silk',
  'filament.manufacturer_color_name': 'Nebula',
  'filament.color': 'Galaxy Blue',
  'filament.colors': 'Galaxy Blue, Purple',
  'filament.color_hex': '#123456',
  'filament.color_hexes': '#123456',
  'filament.color_mode': 'multi',
  'filament.multi_color_style': 'gradient',
  'filament.raw_material_weight_g': 1000,
  'filament.weight': 1000,
  'filament.diameter': '1.75',
  'filament.finish': 'Glossy',
  'filament.density': '1.24',
  'filament.price': '22.5',
  'filament.default_spool_weight_g': '250',
  'filament.spool_outer_diameter_mm': '200',
  'filament.spool_width_mm': '65',
  'filament.spool_material': 'Cardboard',
  'filament.shop_url': 'https://example.test/pla',
  'filament.extruder_temp': 215,
  'filament.bed_temp': 60,
  lot_number: 'LOT-42',
  external_id: 'spoolman:42',
  rfid_uid: 'AA:BB',
  location: 'Rack A',
  status: 'Opened',
  purchase_date: '2026-01-02',
  purchase_price: '24.95',
  remaining_weight_g: '712',
  initial_total_weight_g: '1250',
  empty_spool_weight_g: '250',
  spool_core_weight_g: '42',
  low_weight_threshold_g: '100',
  stocked_in_at: '2026-01-03',
  last_used_at: '2026-01-04',
  created_at: '2026-01-01',
}

let binding: ReturnType<typeof bindFreeformEditorDom> | undefined
afterEach(() => { binding?.destroy(); binding = undefined; document.body.innerHTML = '' })

async function renderDock() {
  const container = await AstroContainer.create()
  document.body.innerHTML = await container.renderToString(FieldDock)
}

describe('built-in field picker compatibility', () => {
  it('groups every expanded filament and spool choice by function', async () => {
    await renderDock()
    const filament = document.querySelector('#freeform-field-panel-filament')!
    expect([...filament.querySelectorAll('summary')].map(node => node.textContent)).toEqual(['Identity', 'Material', 'Packaging', 'Temperatures', 'Drying', 'Print behavior', 'Compatibility'])
    const spool = document.querySelector('#freeform-field-panel-spool')!
    expect(new Set([...spool.querySelectorAll('summary')].map(node => node.textContent))).toEqual(new Set(['Identity', 'Inventory', 'Physical', 'Purchase', 'Lifecycle']))
    for (const key of ['extruder_temp_range_c', 'bed_temp_range_c', 'manufacturer_sku', 'datasheet_url', 'image_url', 'is_discontinued', 'drying_temp_c', 'drying_time_hours', 'softening_temp_c', 'cooling_fan_range_percent', 'chamber_temp_c', 'max_volumetric_speed_mm3_s', 'flow_ratio', 'pressure_advance_k', 'ams_compatibility', 'build_plate_compatibility', 'price_currency']) {
      expect(filament.querySelector(`[data-field-token="{filament.${key}}"]`)?.closest('details')).not.toBeNull()
    }
    for (const key of ['spool_material', 'spool_outer_diameter_mm', 'spool_width_mm', 'rfid_uid_2', 'purchase_currency']) {
      expect(spool.querySelector(`[data-field-token="{${key}}"]`)?.closest('details')).not.toBeNull()
    }
    binding = bindFreeformEditorDom({ controller: createFreeformEditorController() })
    await binding.ready
    const tab = document.querySelector<HTMLButtonElement>('#freeform-field-tab-filament')!
    tab.focus()
    tab.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    expect(document.activeElement?.id).toBe('freeform-field-tab-spool')
    expect(spool.hasAttribute('hidden')).toBe(false)
    expect(filament.hasAttribute('hidden')).toBe(true)
    const controller = createFreeformEditorController()
    binding.destroy()
    binding = bindFreeformEditorDom({ controller })
    await binding.ready
    for (const chip of document.querySelectorAll<HTMLButtonElement>('[data-field-token]')) {
      controller.updateSelected({ template: '' })
      controller.setTemplateSelection(0)
      chip.click()
      const selected = controller.getSelectedElement()
      expect(selected?.type === 'text' && selected.template).toBe(chip.dataset.fieldToken)
    }
  })
  it.each([
    ['filament', filamentFields],
    ['spool', spoolFields],
  ] as const)('offers every previous %s choice with its original label', async (group, fields) => {
    await renderDock()
    const buttons = [...document.querySelectorAll<HTMLButtonElement>(`[data-field-group="${group}"] [data-field-token]`)]
    const choices = buttons.map(button => [button.dataset.fieldToken, button.textContent?.trim()])
    for (const [token, label] of fields) expect(choices).toContainEqual([token, label])
  })

  it('inserts and resolves every displayed built-in, including inline swatches and both IDs', async () => {
    await renderDock()
    const controller = createFreeformEditorController()
    binding = bindFreeformEditorDom({ controller })
    await binding.ready
    for (const [group, fields] of [['filament', filamentFields], ['spool', spoolFields]] as const) {
      document.querySelector<HTMLButtonElement>(`[data-field-group-tab="${group}"]`)!.click()
      for (const [token, , expected] of fields) {
        const button = [...document.querySelectorAll<HTMLButtonElement>(`[data-field-group="${group}"] [data-field-token]`)]
          .find(candidate => candidate.dataset.fieldToken === token)
        expect(button, `${token} must be available for insertion`).toBeDefined()
        controller.updateSelected({ template: 'Before After' })
        controller.setTemplateSelection(7)
        button!.click()
        const selected = controller.getSelectedElement()
        expect(selected?.type).toBe('text')
        if (selected?.type !== 'text') throw new Error('Expected selected text element')
        expect(selected.template).toBe(`Before ${token}After`)
        expect(renderTemplateText(selected.template, data)).toBe(`Before ${expected}After`)
      }
    }
  })
})
