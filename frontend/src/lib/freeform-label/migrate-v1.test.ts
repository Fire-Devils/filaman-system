import { describe, expect, it } from 'vitest'

import { migrateV1PresetData, normalizeDesignerPresetData } from './migrate-v1'
import { createDefaultLabelDesign } from './defaults'
import { LEGACY_DESIGNER_DEFAULTS } from './legacy-v1'

function barePreset() {
  const settings = structuredClone(LEGACY_DESIGNER_DEFAULTS)
  settings.logo.show = false
  settings.title.show = false
  settings.title2.show = false
  settings.info.show = false
  settings.info2.show = false
  settings.qr.show = false
  return settings
}

describe('v1 label designer migration', () => {
  it('converts each visible legacy section into an editable v2 element and retains the source', () => {
    const legacy = {
      label: { width: 60, height: 40, marginMm: 1, border: true },
      logo: { show: true, spaceMm: 6, scaleToFit: true, manualSizeMm: 6, align: 'left' },
      title: { show: true, sizeMm: 4, marginMm: 0, fitToWidth: true, align: 'center', template: '{filament.name}', dividerAbove: false, dividerBelow: true },
      title2: { show: false },
      qr: { show: true, mode: 'logo', sizeMm: 18, position: 'right', vAlign: 'bottom', linkMode: 'spool', urlTemplate: '' },
      info: { show: true, sizeMm: 2.5, marginMm: 0, hAlign: 'left', vAlign: 'bottom', template: '{filament.type}\n{id}' },
      info2: { show: false },
    }
    const source = structuredClone(legacy)
    const ids = ['logo', 'title', 'divider', 'qr', 'info']

    const preset = migrateV1PresetData({ settings: legacy }, 'spool', () => ids.shift()!)

    expect(preset.version).toBe(2)
    expect(preset.legacy_v1).toEqual(source)
    expect(preset.design.label).toEqual({ widthMm: 60, heightMm: 40, marginMm: 1, border: true })
    expect(preset.design.elements.map(element => element.type)).toEqual([
      'manufacturerLogo',
      'text',
      'shape',
      'qr',
      'text',
    ])
    expect(preset.design.elements.map(element => element.id)).toEqual([
      'logo',
      'title',
      'divider',
      'qr',
      'info',
    ])
    expect(preset.design.elements.filter(element => element.type === 'text').map(element => element.template)).toEqual([
      '{filament.name}',
      '{filament.type}\n{id}',
    ])
    expect(preset.design.elements.find(element => element.type === 'shape')?.h).toBeCloseTo(25.4 / 96)
    expect(preset.design.elements.find(element => element.id === 'title')).toMatchObject({ fitToWidth: true })
    expect(normalizeDesignerPresetData(preset, 'spool').design.elements.find(element => element.id === 'title')).toMatchObject({ fitToWidth: true })
    expect(legacy).toEqual(source)
  })

  it('normalizes a v2 preset idempotently without adding legacy data', () => {
    const raw = {
      version: 2 as const,
      design: createDefaultLabelDesign('filament', () => `id-${Math.random()}`),
    }
    const snapshot = structuredClone(raw)

    const first = normalizeDesignerPresetData(raw, 'filament')
    const second = normalizeDesignerPresetData(first, 'filament')

    expect(second).toEqual(first)
    expect(first).not.toHaveProperty('legacy_v1')
    expect(raw).toEqual(snapshot)
  })

  it('keeps the oldest hidden QR mode hidden instead of restoring a default QR', () => {
    const preset = migrateV1PresetData({
      label: { width: 60, height: 40 },
      logo: { show: false },
      title: { show: false },
      title2: { show: false },
      qr: { mode: 'none' },
      info: { show: false },
      info2: { show: false },
    }, 'spool')

    expect(preset.design.elements).toEqual([])
  })

  it.each([
    { version: 3, design: { version: 3, elements: [] } },
    { version: 2, design: { version: 3, elements: [] } },
    { version: 2 },
  ])('rejects unsupported envelopes without interpreting them as legacy settings', raw => {
    const original = structuredClone(raw)
    expect(() => normalizeDesignerPresetData(raw, 'spool')).toThrow(/unsupported/i)
    expect(raw).toEqual(original)
  })
})

describe('existing v1 preset options', () => {
  it('preserves label dimensions, margin, border, and source through a second load', () => {
    const settings = barePreset()
    settings.label = { width: 40, height: 30, marginMm: 0.8, border: true }
    const original = structuredClone(settings)
    const first = migrateV1PresetData({ settings }, 'spool')
    expect(first.design.label).toEqual({ widthMm: 40, heightMm: 30, marginMm: 0.8, border: true })
    expect(first.legacy_v1).toEqual(original)
    expect(normalizeDesignerPresetData(first, 'spool')).toEqual(first)
    expect(settings).toEqual(original)
  })

  it('normalizes numeric strings with the same bounds as V1', () => {
    const settings = barePreset() as unknown as Record<string, unknown>
    settings.label = { width: '45', height: '30', marginMm: '0.5', border: false }
    expect(migrateV1PresetData({ settings }, 'spool').design.label)
      .toMatchObject({ widthMm: 45, heightMm: 30, marginMm: 0.5 })
  })

  it.each(['left', 'center', 'right'] as const)('positions the visible manufacturer logo at %s', align => {
    const settings = barePreset()
    settings.logo = { show: true, spaceMm: 7, scaleToFit: true, manualSizeMm: 6, align }
    const logo = migrateV1PresetData({ settings }, 'spool').design.elements[0]
    expect(logo).toMatchObject({ type: 'manufacturerLogo', y: 1, h: Math.round(7 * 3.78) / (96 / 25.4), objectFit: 'contain', align })
    expect(logo.x).toBe(1)
    expect(logo.w).toBe(58)
    expect(logo).toMatchObject({ collapseWhenEmpty: true })
  })

  it('keeps two titles, alignments, sizes, templates, margins, and both horizontal dividers in order', () => {
    const settings = barePreset()
    settings.title = { show: true, sizeMm: 4, marginMm: 2, fitToWidth: true, align: 'center', template: '=={filament.type}==', dividerAbove: true, dividerBelow: true }
    settings.title2 = { show: true, sizeMm: 3, marginMm: 1, fitToWidth: false, align: 'right', template: '{filament.name}', dividerAbove: true, dividerBelow: true }
    const elements = migrateV1PresetData({ settings }, 'filament').design.elements
    expect(elements.map(element => element.type)).toEqual(['shape', 'text', 'shape', 'shape', 'text', 'shape'])
    expect(elements.filter(element => element.type === 'shape')).toEqual(expect.arrayContaining([
      expect.objectContaining({ shape: 'rectangle', w: 58, h: 25.4 / 96, fill: '#000000' }),
    ]))
    expect(elements.filter(element => element.type === 'text')).toMatchObject([
      { template: '=={filament.type}==', align: 'center', fontSizeMm: 4, fitToWidth: true, wrap: false },
      { template: '{filament.name}', align: 'right', fontSizeMm: 3, fitToWidth: false },
    ])
    expect(elements[1].y).toBeCloseTo(3 + 25.4 / 96)
  })

  it.each([
    ['left', 'top', 1, 1], ['left', 'center', 1, 11], ['left', 'bottom', 1, 21],
    ['right', 'top', 41, 1], ['right', 'center', 41, 11], ['right', 'bottom', 41, 21],
  ] as const)('places QR %s/%s at (%s,%s) and reserves the opposite side for info', (position, vAlign, x, y) => {
    const settings = barePreset()
    settings.qr = { show: true, mode: 'colorLogo', sizeMm: 18, position, vAlign, linkMode: 'url', urlTemplate: 'https://example.test/{id}' }
    settings.info.show = true
    settings.info.template = '{filament.type}'
    const [qr, info] = migrateV1PresetData({ settings }, 'spool').design.elements
    expect(qr).toMatchObject({ type: 'qr', x, y, w: 18, h: 18, mode: 'colorLogo', linkMode: 'url', urlTemplate: 'https://example.test/{id}' })
    expect(info).toMatchObject({ type: 'text', x: position === 'left' ? 20.5 : 1, w: 38.5 })
  })

  it.each(['simple', 'logo', 'colorLogo'] as const)('keeps QR mode %s and preserves V1 overflow', mode => {
    const settings = barePreset()
    settings.qr = { show: true, mode, sizeMm: 50, position: 'right', vAlign: 'bottom', linkMode: 'spool', urlTemplate: '' }
    expect(migrateV1PresetData({ settings }, 'spool').design.elements[0]).toMatchObject({
      type: 'qr', mode, linkMode: 'spool', w: 40, h: 40, x: 1, y: -1,
    })
  })

  it.each([['left', 41], ['right', 1]] as const)('keeps the QR-only V1 flex placement when direction is %s', (position, x) => {
    const settings = barePreset()
    settings.qr = { ...settings.qr, show: true, position, sizeMm: 18 }
    expect(migrateV1PresetData({ settings }, 'spool').design.elements[0]).toMatchObject({ type: 'qr', x })
  })

  it('preserves a legacy QR larger than the label height', () => {
    const settings = barePreset()
    settings.label.height = 20
    settings.qr = { ...settings.qr, show: true, sizeMm: 40, vAlign: 'top' }
    expect(migrateV1PresetData({ settings }, 'spool').design.elements[0]).toMatchObject({ type: 'qr', w: 40, h: 40 })
  })

  it('keeps hidden sections absent even when they contain text', () => {
    const settings = barePreset()
    settings.title.template = 'Hidden'
    settings.info2.template = 'Hidden'
    expect(migrateV1PresetData({ settings }, 'spool').design.elements).toEqual([])
  })

  it.each([false, true])('upgrades the older QR icon/colorLogo flag (%s)', colorLogo => {
    const settings = barePreset() as unknown as Record<string, unknown>
    settings.qr = { show: true, mode: 'icon', colorLogo, sizeMm: 12 }
    expect(migrateV1PresetData({ settings }, 'spool').design.elements[0]).toMatchObject({
      type: 'qr', mode: colorLogo ? 'colorLogo' : 'logo', w: 12, h: 12,
    })
  })

  it('places both visible info fields in adjacent columns with their own text settings', () => {
    const settings = barePreset()
    settings.info = { show: true, sizeMm: 2, marginMm: 2, hAlign: 'right', vAlign: 'top', template: 'A' }
    settings.info2 = { show: true, vsep: false, sizeMm: 3, hAlign: 'center', vAlign: 'bottom', template: 'B' }
    expect(migrateV1PresetData({ settings }, 'spool').design.elements).toMatchObject([
      { type: 'text', template: 'A', x: 1, y: 3, w: 28.25, fontSizeMm: 2, align: 'right', wrap: true },
      { type: 'text', template: 'B', x: 30.75, y: 3, w: 28.25, fontSizeMm: 3, align: 'center', wrap: true },
    ])
  })

  it('uses the bordered content inset and reverses both information columns when QR is left', () => {
    const settings = barePreset()
    settings.label.border = true
    settings.qr = { ...settings.qr, show: true, position: 'left' }
    settings.info = { ...settings.info, show: true, template: 'First' }
    settings.info2 = { ...settings.info2, show: true, vsep: true, template: 'Second' }
    const elements = migrateV1PresetData({ settings }, 'spool').design.elements
    const first = elements.find(element => element.type === 'text' && element.template === 'First')!
    const second = elements.find(element => element.type === 'text' && element.template === 'Second')!
    const separator = elements.find(element => element.type === 'shape')!
    expect(elements[0].x).toBeCloseTo(1.6)
    expect(second.x).toBeLessThan(separator.x)
    expect(separator.x).toBeLessThan(first.x)
  })

  it('keeps the v1 default QR logo mode when the setting is missing', () => {
    const settings = barePreset()
    settings.qr = { ...settings.qr, show: true }
    delete (settings.qr as Partial<typeof settings.qr>).mode
    expect(migrateV1PresetData({ settings }, 'spool').design.elements[0]).toMatchObject({ mode: 'logo' })
  })

  it('retains a requested vertical separator between dual info fields', () => {
    const settings = barePreset()
    settings.info.show = true
    settings.info2 = { ...settings.info2, show: true, vsep: true, template: 'Second' }
    const elements = migrateV1PresetData({ settings }, 'spool').design.elements
    const info = elements.filter(element => element.type === 'text')
    const separator = elements.find(element => element.type === 'shape' && element.h > element.w)!
    expect(separator).toBeDefined()
    expect(separator.x - info[0].x - info[0].w).toBeCloseTo(1.5)
    expect(info[1].x - separator.x - separator.w).toBeCloseTo(1.5)
  })

  it('keeps a visible but empty second info column and its requested separator', () => {
    const settings = barePreset()
    settings.info.show = true
    settings.info2 = { ...settings.info2, show: true, vsep: true, template: '' }
    const elements = migrateV1PresetData({ settings }, 'spool').design.elements
    expect(elements.filter(element => element.type === 'text')).toHaveLength(2)
    expect(elements.some(element => element.type === 'shape' && element.h > element.w)).toBe(true)
  })

  it('places a divider above the title before its top margin, as v1 did', () => {
    const settings = barePreset()
    settings.title = { ...settings.title, show: true, marginMm: 2, dividerAbove: true }
    expect(migrateV1PresetData({ settings }, 'spool').design.elements[0]).toMatchObject({
      type: 'shape', y: 1,
    })
  })

  it('preserves each info field vertical alignment', () => {
    const settings = barePreset()
    settings.info = { ...settings.info, show: true, vAlign: 'center', template: 'First' }
    settings.info2 = { ...settings.info2, show: true, vAlign: 'bottom', template: 'Second' }
    expect(migrateV1PresetData({ settings }, 'spool').design.elements).toMatchObject([
      { type: 'text', verticalAlign: 'middle' }, { type: 'text', verticalAlign: 'bottom' },
    ])
  })

  it('keeps a non-fitting legacy title on one line rather than enabling word wrap', () => {
    const settings = barePreset()
    settings.title = { ...settings.title, show: true, fitToWidth: false, template: 'Long title' }
    expect(migrateV1PresetData({ settings }, 'spool').design.elements[0]).toMatchObject({
      type: 'text', fitToWidth: false, wrap: false,
    })
  })

  it('honors the manual logo size when scale-to-fit is disabled', () => {
    const settings = barePreset()
    settings.logo = { show: true, spaceMm: 12, scaleToFit: false, manualSizeMm: 4, align: 'left' }
    const preset = migrateV1PresetData({ settings }, 'spool')
    const logo = normalizeDesignerPresetData(preset, 'spool').design.elements[0]
    expect(logo).toMatchObject({ type: 'manufacturerLogo', h: Math.round(12 * 3.78) / (96 / 25.4), manualSizeMm: 4 })
  })

  it('keeps the legacy divider below a visible logo when the title is hidden', () => {
    const settings = barePreset()
    settings.logo.show = true
    settings.title.dividerBelow = true
    const elements = migrateV1PresetData({ settings }, 'spool').design.elements
    expect(elements.map(element => element.type)).toEqual(['manufacturerLogo', 'shape'])
    expect(elements[1]).toMatchObject({ legacyLogoDivider: true })
  })
})
