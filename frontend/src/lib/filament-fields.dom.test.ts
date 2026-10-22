// @vitest-environment happy-dom
import { experimental_AstroContainer as AstroContainer } from 'astro/container'
import { describe, expect, it } from 'vitest'

import FilamentForm from '../components/FilamentForm.astro'
import { buildFilamentDetailSections } from './filament-detail'
import { setLang, t } from './i18n'

describe('filament view/edit field coverage', () => {
  it.each(['create', 'edit'])('keeps the %s form and detail sections in the same field order', async mode => {
    const container = await AstroContainer.create()
    document.body.innerHTML = await container.renderToString(FilamentForm, { props: { mode } })
    const sections = [...document.querySelectorAll('[data-filament-section]')]
    const detail = buildFilamentDetailSections({})
    expect(sections.map(section => section.getAttribute('data-filament-section'))).toEqual([
      'material', 'spool', 'temperatures', 'drying', 'printBehavior', 'compatibilitySources',
    ])
    for (const [index, section] of sections.entries()) {
      expect(section.querySelector('h2')?.getAttribute('data-i18n')).toBe(detail[index].titleKey)
      const detailLabels = detail[index].rows.map(row => row.labelKey)
      const formLabels = [...section.querySelectorAll('.filament-form-section-body > [data-dirty-key]')]
        .map(row => row.querySelector('label[data-i18n], label [data-i18n], :scope > span[data-i18n]')?.getAttribute('data-i18n'))
        .filter(label => detailLabels.includes(label!))
      expect(detailLabels).toEqual(formLabels)
    }
  })

  it('retains specialized inputs, required fields, range bounds and native validation', async () => {
    const container = await AstroContainer.create()
    document.body.innerHTML = await container.renderToString(FilamentForm, { props: { mode: 'edit' } })
    const input = (id: string) => document.getElementById(id) as HTMLInputElement
    for (const id of ['manufacturer_id', 'type', 'designation', 'diameter_mm']) expect(input(id).required).toBe(true)
    expect(input('diameter_mm').value).toBe('1.75')
    expect(input('price_currency').maxLength).toBe(3)
    expect(input('is_discontinued').type).toBe('checkbox')
    expect(input('shop_url').type).toBe('url')
    expect(input('custom_type').maxLength).toBe(50)
    for (const prefix of ['extruder_temp', 'bed_temp', 'cooling_fan']) {
      for (const suffix of ['value', 'to']) expect(input(`${prefix}_${suffix}`).step).toBe('any')
    }
    expect(input('cooling_fan_value').min).toBe('0')
    expect(input('cooling_fan_to').max).toBe('100')
    expect([...document.querySelectorAll('#finish_type option')].map(option => (option as HTMLOptionElement).value))
      .toEqual(['', 'solid', 'matte', 'silk', 'translucent', 'neon', 'glow'])
    expect(document.querySelector('#filament-color-dialog')).not.toBeNull()
    expect(document.querySelector('#custom-fields-container')).not.toBeNull()
    expect([...document.querySelectorAll('[data-filament-section] [data-dirty-key]')].map(row => row.getAttribute('data-dirty-key'))).toEqual([
      'material_type', 'diameter_mm', 'material_subgroup', 'finish_type', 'designation', 'density_g_cm3', 'is_discontinued',
      'filamentdb_spool_profile_id filamentdb_spool_image_file', 'raw_material_weight_g', 'default_spool_weight_g', 'spool_material', 'spool_outer_diameter_mm', 'spool_width_mm', 'price', 'price_currency',
      'extruder_temp_range_c', 'bed_temp_range_c', 'chamber_temp_c', 'softening_temp_c', 'drying_temp_c', 'drying_time_hours',
      'cooling_fan_range_percent', 'max_volumetric_speed_mm3_s', 'flow_ratio', 'pressure_advance_k',
      'ams_compatibility', 'build_plate_compatibility', 'manufacturer_sku', 'shop_url', 'datasheet_url', 'image_url',
    ])
  })

  it('formats zeroes, translated choices, ranges, lists and links without duplicating hero/currency fields', () => {
    const sections = buildFilamentDetailSections({
      designation: 'Basic', price_currency: 'EUR', finish_type: 'matte', is_discontinued: false,
      raw_material_weight_g: 0, spool_width_mm: 0, extruder_temp_range_c: { min: null, max: 220 },
      bed_temp_range_c: 0, cooling_fan_range_percent: { min: 0, max: 100 },
      ams_compatibility: ['AMS', 'AMS 2 Pro'], build_plate_compatibility: [],
      shop_url: 'https://example.invalid/pla',
    }, { finish: 'Matte', discontinued: 'No', price: '0.00 EUR' })
    const rows = sections.flatMap(section => section.rows)
    expect(rows.find(row => row.labelKey === 'filaments.finishType')?.value).toBe('Matte')
    expect(rows.find(row => row.labelKey === 'filaments.discontinued')?.value).toBe('No')
    expect(rows.find(row => row.labelKey === 'filaments.rawMaterialWeightLabel')?.value).toBe('0 g')
    expect(rows.find(row => row.labelKey === 'spools.spoolWidthLabel')?.value).toBe('0 mm')
    expect(rows.find(row => row.labelKey === 'filaments.extruderTemperatureLabel')?.value).toBe('220 °C')
    expect(rows.find(row => row.labelKey === 'filaments.bedTemperatureLabel')?.value).toBe('0 °C')
    expect(rows.find(row => row.labelKey === 'filaments.coolingFanLabel')?.value).toBe('0–100%')
    expect(rows.find(row => row.labelKey === 'filaments.amsCompatibility')?.value).toBe('AMS, AMS 2 Pro')
    expect(rows.find(row => row.labelKey === 'filaments.buildPlateCompatibility')?.value).toBe('—')
    expect(rows.find(row => row.labelKey === 'filaments.price')?.value).toBe('0.00 EUR')
    expect(rows.find(row => row.labelKey === 'filaments.shopUrl')).toEqual({ labelKey: 'filaments.shopUrl', value: 'https://example.invalid/pla', href: 'https://example.invalid/pla' })
    expect(rows.some(row => ['filaments.designation', 'filaments.priceCurrency'].includes(row.labelKey))).toBe(false)
  })

  it('uses the editor choice labels for translated finish, material and boolean values', () => {
    setLang('de')
    try {
      const sections = buildFilamentDetailSections({ finish_type: 'matte', spool_material: 'Cardboard', is_discontinued: false }, { translate: t })
      const rows = sections.flatMap(section => section.rows)
      expect(rows.find(row => row.labelKey === 'filaments.finishType')?.value).toBe(t('filaments.finishMatte'))
      expect(rows.find(row => row.labelKey === 'spools.spoolMaterial')?.value).toBe(t('spools.spoolMaterialCardboard'))
      expect(rows.find(row => row.labelKey === 'filaments.discontinued')?.value).toBe(t('common.no'))
    } finally {
      setLang('en')
    }
  })
})
