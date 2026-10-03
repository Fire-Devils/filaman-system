import { describe, expect, it } from 'vitest'

import {
  buildFilamentDetailSections,
  buildFilamentHeaderName,
  buildFilamentHeroStyle,
  buildFilamentSwatchStyle,
  formatHeaderId,
  renderFilamentHeaderColors,
} from './filament-detail'

describe('filament detail presentation', () => {
  it('builds the same non-repeating product identity for filament and spool headers', () => {
    expect(buildFilamentHeaderName({
      manufacturer: { name: 'AnyCubic' }, material_type: 'PLA', designation: 'Basic',
    })).toBe('AnyCubic PLA Basic')
    expect(buildFilamentHeaderName({
      manufacturer: { name: 'Bambu Lab' }, material_type: 'PETG', designation: 'PETG Basic',
    })).toBe('Bambu Lab PETG Basic')
    expect(buildFilamentHeaderName({
      manufacturer: { name: 'AnyCubic' }, material_type: 'PLA', material_subgroup: 'CF', designation: 'PLA-CF Basic',
    })).toBe('AnyCubic PLA-CF Basic')
    expect(buildFilamentHeaderName({
      manufacturer: { name: 'Polymaker' }, material_type: 'PLA', material_subgroup: 'Silk', designation: 'PolyLite Dual Silk',
    })).toBe('Polymaker PLA PolyLite Dual Silk')
    expect(buildFilamentHeaderName({
      manufacturer: { name: 'Bambu Lab' }, material_type: 'PETG', designation: 'Basic PETG',
    })).toBe('Bambu Lab Basic PETG')
    expect(formatHeaderId(3)).toBe('03')
    expect(formatHeaderId(103)).toBe('103')
  })

  it('aligns ordered hex codes below multicolor swatch sections and keeps names beside them', () => {
    const html = renderFilamentHeaderColors({
      manufacturer_color_name: 'Sunset Mix',
      colors: [
        { color: { name: 'Orange', hex_code: '#FF7A1A' } },
        { color: { name: 'Blue', hex_code: '#2563EB' } },
      ],
      multi_color_style: 'striped',
    }, 'Sold as')

    expect(html).toContain('class="filament-color-hexes"')
    expect(html).toContain('grid-template-columns:repeat(2,minmax(0,1fr))')
    expect(html).toContain('<code>#FF7A1A</code><code>#2563EB</code>')
    expect(html).toContain('Orange · Blue')
    expect(html).toContain('Sold as: Sunset Mix')
    expect(html).toContain('linear-gradient(90deg, #FF7A1A 0% 50%, #2563EB 50% 100%)')
  })

  it('does not repeat the maker color name when it matches the selected color', () => {
    const html = renderFilamentHeaderColors({
      manufacturer_color_name: 'Jade White',
      colors: [{ color: { name: 'Jade White', hex_code: '#F1F4E8' } }],
    }, 'Sold as')

    expect(html).toContain('<code>#F1F4E8</code>')
    expect(html).toContain('Jade White')
    expect(html).not.toContain('Sold as:')
  })

  it('uses the requested six compact sections and keeps temperatures as normal rows', () => {
    const sections = buildFilamentDetailSections({
      material_type: 'PETG',
      diameter_mm: 1.75,
      density_g_cm3: 1.27,
      raw_material_weight_g: 1000,
      default_spool_weight_g: 250,
      extruder_temp_range_c: { min: 220, max: 250 },
      bed_temp_range_c: 70,
      drying_temp_c: 65,
      drying_time_hours: 8,
      cooling_fan_range_percent: { min: 20, max: 50 },
      ams_compatibility: ['AMS'],
    })

    expect(sections.map((section) => section.key)).toEqual([
      'material',
      'spool',
      'temperatures',
      'drying',
      'printBehavior',
      'compatibilitySources',
    ])
    expect(sections[2].rows).toEqual([
      { labelKey: 'filaments.extruderTemperatureLabel', value: '220–250 °C' },
      { labelKey: 'filaments.bedTemperatureLabel', value: '70 °C' },
      { labelKey: 'filaments.chamberTemperatureLabel', value: '—' },
      { labelKey: 'filaments.softeningTemperatureLabel', value: '—' },
    ])
  })

  it('keeps all standard rows and sections visible when values are missing', () => {
    const sections = buildFilamentDetailSections({ material_type: 'PLA' })

    expect(sections).toHaveLength(6)
    expect(sections[0].rows).toEqual([
      { labelKey: 'filaments.type', value: 'PLA' },
      { labelKey: 'filaments.materialSubgroup', value: '—' },
      { labelKey: 'filaments.finishType', value: '—' },
      { labelKey: 'filaments.diameter', value: '—' },
      { labelKey: 'filaments.densityLabel', value: '—' },
      { labelKey: 'filaments.discontinued', value: '—' },
    ])
    expect(sections[2].rows[0]).toEqual({
      labelKey: 'filaments.extruderTemperatureLabel',
      value: '—',
    })
  })

  it('allows the spool page to distinguish filament packaging defaults', () => {
    const sections = buildFilamentDetailSections({}, {
      spoolTitleKey: 'filaments.packagingDefaults',
    })

    expect(sections[1].titleKey).toBe('filaments.packagingDefaults')
  })

  it('uses striped and gradient multicolor hero treatments', () => {
    const colors = [
      { color: { hex_code: '#FF0000' } },
      { color: { hex_code: '#0000FF' } },
    ]

    expect(buildFilamentHeroStyle({ colors, multi_color_style: 'striped' }))
      .toContain('linear-gradient(to right')
    expect(buildFilamentHeroStyle({ colors, multi_color_style: 'gradient' }))
      .toContain('linear-gradient(135deg')
  })

  it('keeps opaque multicolor hero colors visibly saturated', () => {
    const style = buildFilamentHeroStyle({
      colors: [
        { color: { hex_code: '#FF8000' } },
        { color: { hex_code: '#0064FF' } },
      ],
      multi_color_style: 'striped',
    })

    expect(style).toContain('rgba(255, 128, 0, 0.68)')
    expect(style).toContain('rgba(0, 100, 255, 0.68)')
  })

  it('shows translucent single colors over a checkerboard', () => {
    const style = buildFilamentHeroStyle({
      colors: [{ color: { hex_code: '#E8F4FF66' } }],
    })

    expect(style).toContain('conic-gradient(')
    expect(style).toContain('rgba(232, 244, 255, 0.4)')
    expect(style).toContain('background-size: auto, 18px 18px')
    expect(style).not.toContain(') 0 /')
  })

  it('keeps the checkerboard behind translucent multicolor treatments', () => {
    const style = buildFilamentHeroStyle({
      colors: [
        { color: { hex_code: '#FF000080' } },
        { color: { hex_code: '#0000FFFF' } },
      ],
      multi_color_style: 'gradient',
    })

    expect(style).toContain('conic-gradient(')
    expect(style).toContain('rgba(255, 0, 0, 0.502)')
    expect(style).toContain('background-size: auto, 18px 18px')
  })

  it('builds a full-color multicolor pill with transparency preview', () => {
    const style = buildFilamentSwatchStyle({
      colors: [
        { color: { hex_code: '#FF000080' } },
        { color: { hex_code: '#0000FFFF' } },
      ],
      multi_color_style: 'striped',
    })

    expect(style).toContain('linear-gradient(90deg')
    expect(style).toContain('rgba(255, 0, 0, 0.502) 0% 50%')
    expect(style).toContain('conic-gradient(')
  })

  it('renders opaque multicolor swatches as one set of broad bands', () => {
    const style = buildFilamentSwatchStyle({
      colors: [
        { color: { hex_code: '#FF7A1A' } },
        { color: { hex_code: '#F1F4E8' } },
      ],
      multi_color_style: 'striped',
    })

    expect(style).toContain('#FF7A1A 0% 50%')
    expect(style).toContain('#F1F4E8 50% 100%')
    expect(style).toContain('background-size: 100% 100%')
  })
})
