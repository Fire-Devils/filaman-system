// @vitest-environment happy-dom

import { beforeEach, expect, it } from 'vitest'

import { createDefaultLabelDesign } from './defaults'
import { loadStoredFreeformLabelDesign, readStoredPresets } from './editor-storage'
import { normalizeDesignerPresetData } from './migrate-v1'

const options = { settingsKey: 'working-design', presetsKey: 'saved-presets', kind: 'spool' as const }

beforeEach(() => localStorage.clear())

it('opens an unsaved V1 working layout before any saved preset', () => {
  localStorage.setItem(options.settingsKey, JSON.stringify({
    version: 1,
    settings: { label: { width: 72 }, title: { template: 'Unsaved draft' } },
  }))
  localStorage.setItem(options.presetsKey, JSON.stringify({
    version: 2,
    presets: [{ name: 'Default', data: { version: 2, design: createDefaultLabelDesign('spool') } }],
  }))

  const design = loadStoredFreeformLabelDesign(options)

  expect(design.label.widthMm).toBe(72)
  expect(design.elements.some(element => element.type === 'text' && element.template === 'Unsaved draft')).toBe(true)
})

it('opens the global V1 spool draft only when its entity-specific working key is absent', () => {
  const globalDraft = JSON.stringify({ label: { width: 72 }, title: { template: 'Global unsaved draft' } })
  localStorage.setItem('filaman-label-designer-v1', globalDraft)
  const spool = { ...options, settingsKey: 'filaman-spool-label-designer-v1' }

  const design = loadStoredFreeformLabelDesign(spool)

  expect(design.label.widthMm).toBe(72)
  expect(design.elements.some(element => element.type === 'text' && element.template === 'Global unsaved draft')).toBe(true)
  expect(localStorage.getItem('filaman-label-designer-v1')).toBe(globalDraft)
  expect(localStorage.getItem(spool.settingsKey)).toBeNull()
  expect(loadStoredFreeformLabelDesign({ ...options, kind: 'filament' }).label.widthMm).toBe(60)

  localStorage.setItem(spool.settingsKey, JSON.stringify({ version: 1, settings: { label: { width: 80 } } }))
  expect(loadStoredFreeformLabelDesign(spool).label.widthMm).toBe(80)
  localStorage.setItem(spool.settingsKey, JSON.stringify({ version: 3, design: {} }))
  expect(loadStoredFreeformLabelDesign(spool).label.widthMm).toBe(60)
})

it.each(['array', 'object'])('opens a legacy Default preset from the %s cache without rewriting it', format => {
  const presets = [{ name: 'Default', settings: { label: { width: 72 }, title: { template: 'Legacy default' } } }]
  const raw = JSON.stringify(format === 'array' ? presets : { version: 1, presets })
  localStorage.setItem(options.presetsKey, raw)

  const design = loadStoredFreeformLabelDesign(options)

  expect(design.label.widthMm).toBe(72)
  expect(design.elements.some(element => element.type === 'text' && element.template === 'Legacy default')).toBe(true)
  expect(localStorage.getItem(options.presetsKey)).toBe(raw)
})

it('reads supported payloads through the canonical adapter and leaves unsupported browser data untouched', () => {
  const raw = JSON.stringify({ version: 2, presets: [
    { name: 'Future', data: { version: 3, design: { version: 3 } } },
    { name: 'Invalid V2', data: { version: 2, design: { version: 3 } } },
    { name: 'Legacy payload', data: { version: 1, settings: { label: { width: 72 } } } },
    { name: 'Missing payload' },
    null,
  ] })
  localStorage.setItem(options.presetsKey, raw)

  const presets = readStoredPresets(options.presetsKey)

  expect(presets.map(preset => preset.name)).toEqual(['Legacy payload'])
  expect(presets[0].data).toMatchObject({ version: 2, legacy_v1: { label: { width: 72 } } })
  expect(presets[0].data.design.label.widthMm).toBe(72)
  expect(localStorage.getItem(options.presetsKey)).toBe(raw)
})

it('uses the named Default preset rather than the first saved preset', () => {
  const first = createDefaultLabelDesign('spool')
  first.label.widthMm = 30
  const namedDefault = createDefaultLabelDesign('spool')
  namedDefault.label.widthMm = 70
  localStorage.setItem(options.presetsKey, JSON.stringify({
    version: 2,
    presets: [
      { name: 'A preset', data: { version: 2, design: first } },
      { name: 'Default', data: { version: 2, design: namedDefault } },
    ],
  }))

  expect(loadStoredFreeformLabelDesign(options).label.widthMm).toBe(70)
})

it('uses built-in defaults when no preset is named Default', () => {
  const unrelated = createDefaultLabelDesign('spool')
  unrelated.label.widthMm = 30
  localStorage.setItem(options.presetsKey, JSON.stringify({
    version: 2,
    presets: [{ name: 'A preset', data: { version: 2, design: unrelated } }],
  }))

  expect(loadStoredFreeformLabelDesign(options).label.widthMm).toBe(60)
})


it('converts V1 and V2 preset emphasis when loaded, without rewriting the stored source', () => {
  const legacy = { version: 1, settings: { title: { template: '**Bold** *italic* ***both***' } } }
  const converted = normalizeDesignerPresetData(legacy, 'spool')
  const title = converted.design.elements.find(element => element.type === 'text' && element.legacyTextRole === 'title')!
  expect(title).toMatchObject({ template: '[b]Bold[/b] [i]italic[/i] [b][i]both[/i][/b]' })
  expect(converted.legacy_v1).toEqual(legacy.settings)

  const oldV2 = structuredClone(converted)
  const oldTitle = oldV2.design.elements.find(element => element.id === title.id)!
  if (oldTitle.type !== 'text') throw new Error('Expected text title')
  oldTitle.template = '**Bold** *italic* ***both***'
  const raw = JSON.stringify({ version: 2, presets: [{ name: 'Default', data: oldV2 }] })
  localStorage.setItem(options.presetsKey, raw)
  expect(loadStoredFreeformLabelDesign(options).elements.find(element => element.id === title.id)).toEqual(title)
  expect(readStoredPresets(options.presetsKey)[0].data.design.elements.find(element => element.id === title.id)).toEqual(title)
  localStorage.setItem(options.settingsKey, JSON.stringify(oldV2))
  expect(loadStoredFreeformLabelDesign(options).elements.find(element => element.id === title.id)).toEqual(title)
  expect(normalizeDesignerPresetData(converted, 'spool')).toEqual(converted)
  expect(localStorage.getItem(options.presetsKey)).toBe(raw)
})

it('preserves long legacy templates instead of truncating converted markup on the next load', () => {
  const template = '*' + 'a'.repeat(7998) + '*'
  const original = { version: 1, settings: { title: { template } } }
  const first = normalizeDesignerPresetData(original, 'spool')
  const second = normalizeDesignerPresetData(first, 'spool')
  expect(second).toEqual(first)
  expect(first.design.elements.find(element => element.type === 'text' && element.legacyTextRole === 'title')).toMatchObject({ template })
})
