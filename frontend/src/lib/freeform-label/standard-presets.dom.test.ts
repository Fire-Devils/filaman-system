// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest'
import { buildSpoolDataFromFlatLabel } from '../label-designer'
import { getStandardLabelPresets } from './standard-presets'
import { renderFreeformLabel } from './render'

describe('standard label content', () => {
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
