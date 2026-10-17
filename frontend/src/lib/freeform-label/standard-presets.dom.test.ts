// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest'
import fr from '../../i18n/fr.json'
import { setLang } from '../i18n'
import { getStandardLabelPresets } from './standard-presets'

describe('standard label content', () => {
  it('translates shown names and printed headings but keeps the stable English names', () => {
    try {
      setLang('fr')
      const presets = getStandardLabelPresets('spool')
      expect(presets.map(preset => preset.name)).toEqual(['Classic (40 × 30 mm)', 'QR focused (40 × 30 mm)'])
      expect(presets.map(preset => preset.label)).toEqual([
        `${fr.labelDesigner.standardPresetClassic} (40 × 30 mm)`,
        `${fr.labelDesigner.standardPresetQrFocused} (40 × 30 mm)`,
      ])
      const classic = presets[0].data.design.elements
        .filter(element => element.type === 'text')
        .map(element => element.template)
        .join('\n')
      for (const heading of ['standardFieldId', 'standardFieldDiameter', 'standardFieldStockedIn'] as const) {
        expect(classic).toContain(`]${fr.labelDesigner[heading]}[/if]`)
      }
      expect(classic).not.toMatch(/Diameter:|Stocked in:/)
    } finally { setLang('en') }
  })

  it('ships entity-appropriate Classic content in the same two 40 by 30 presets', () => {
    const spoolPresets = getStandardLabelPresets('spool')
    const filamentPresets = getStandardLabelPresets('filament')
    const templates = (presets: typeof spoolPresets, name = 'Classic (40 × 30 mm)') => presets
      .find(preset => preset.name === name)!.data.design.elements
      .filter(element => element.type === 'text')
      .map(element => element.template)
    const spoolClassic = templates(spoolPresets)
    const filamentClassic = templates(filamentPresets)

    expect(spoolPresets.map(preset => preset.name)).toEqual([
      'Classic (40 × 30 mm)',
      'QR focused (40 × 30 mm)',
    ])
    expect(filamentPresets.map(preset => preset.name)).toEqual(spoolPresets.map(preset => preset.name))
    expect(spoolPresets.every(preset => preset.data.design.label.widthMm === 40
      && preset.data.design.label.heightMm === 30)).toBe(true)
    expect([...spoolClassic, ...filamentClassic].join('\n')).not.toMatch(/filament\.name|extruder_temp|bed_temp|extra\./)
    expect(filamentClassic.join('\n')).toContain('{filament.raw_material_weight_g}')
    expect(filamentClassic.join('\n')).not.toContain('{stocked_in_at|date}')
    expect(spoolClassic.join('\n')).toContain('{stocked_in_at|date}')
    expect(spoolClassic.join('\n')).not.toContain('{filament.raw_material_weight_g}')
    expect(spoolClassic.some(template => template.includes('{filament.color}') && template.includes('{filament.color_hex}'))).toBe(true)

    const band = spoolPresets[0].data.design.elements.find(element => element.type === 'shape')
    expect(band).toMatchObject({ x: 0, w: 40, fill: '#000000' })
  })

  it('centers every bundled manufacturer logo without stretching it', () => {
    const logos = getStandardLabelPresets().flatMap(preset =>
      preset.data.design.elements.filter(element => element.type === 'manufacturerLogo'))

    expect(logos.length).toBeGreaterThan(0)
    expect(logos.every(logo => logo.align === 'center' && logo.objectFit === 'contain')).toBe(true)
  })

})
