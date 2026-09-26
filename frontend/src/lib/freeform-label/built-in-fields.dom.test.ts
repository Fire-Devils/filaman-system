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
  it.each([
    ['filament', filamentFields],
    ['spool', spoolFields],
  ] as const)('offers every previous %s choice in its original order', async (group, fields) => {
    await renderDock()
    const buttons = [...document.querySelectorAll<HTMLButtonElement>(`[data-field-group="${group}"] [data-field-token]`)]
    expect(buttons.map(button => [button.dataset.fieldToken, button.textContent?.trim()]))
      .toEqual(fields.map(([token, label]) => [token, label]))
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
