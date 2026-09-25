// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest'
import { buildSpoolDataFromFlatLabel } from '../label-designer'
import { getStandardLabelPresets } from './standard-presets'
import { renderFreeformLabel } from './render'

describe('standard label content', () => {
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

  it('wraps long color names while fitting single-line material bands', async () => {
    const preset = getStandardLabelPresets().find(preset => preset.name === 'Classic (40 × 30 mm)')!
    const root = document.createElement('div')
    const name = 'Midnight Blue and Purple Galaxy'
    await renderFreeformLabel({
      element: root,
      design: { ...preset.data.design, elements: preset.data.design.elements.filter(element => element.type === 'text') },
      data: buildSpoolDataFromFlatLabel({ id: 1, type: 'PETG', color: name }),
    })
    const nodes = Array.from(root.querySelectorAll<HTMLElement>('[data-label-element-type="text"]'))
    expect(nodes.find(node => node.textContent === name)?.style.whiteSpace).toBe('normal')
    expect(nodes.find(node => node.textContent === 'PETG')?.style.whiteSpace).toBe('nowrap')
    expect(root.textContent).not.toContain('?')
  })
})
