// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  buildDesignerPresetCache,
  buildLabelPresetUpsertBody,
  clearLabelPresetBrowserStorage,
  deleteLabelPreset,
  hydrateLabelPresetStorage,
  saveLabelPreset,
} from './label-preset-storage'
import { createDefaultLabelDesign } from './freeform-label/defaults'
import { persistStoredPresetMutation, readStoredPresets } from './freeform-label/editor-storage'
import { api } from './api'
import { needsBrowserPresetMigration, readBrowserPresetsForMigration } from './label-preset-browser-migration'

beforeEach(() => {
  clearLabelPresetBrowserStorage()
  localStorage.clear()
})

afterEach(() => {
  vi.restoreAllMocks()
  clearLabelPresetBrowserStorage()
  localStorage.clear()
})

describe('label preset cache migration', () => {
  it('keeps unsaved working designs for the same account across logout and login', async () => {
    localStorage.setItem('filaman-label-presets-owner-v1', '1')
    localStorage.setItem('filaman-label-presets-db-migrated-v1', 'complete')
    localStorage.setItem('filaman-spool-label-designer-v1', '{"assetId":"private"}')
    localStorage.setItem('filaman-filament-label-designer-v1', '{"assetId":"private"}')

    clearLabelPresetBrowserStorage()

    expect(localStorage.getItem('filaman-spool-label-designer-v1')).toBe('{"assetId":"private"}')
    expect(localStorage.getItem('filaman-filament-label-designer-v1')).toBe('{"assetId":"private"}')
    const get = vi.spyOn(api, 'get').mockResolvedValue([])
    try {
      await hydrateLabelPresetStorage(1)
      expect(localStorage.getItem('filaman-spool-label-designer-v1')).toBe('{"assetId":"private"}')
    } finally {
      get.mockRestore()
      clearLabelPresetBrowserStorage()
    }
  })

  it('clears a previous account’s working designs before loading another account', async () => {
    localStorage.setItem('filaman-label-presets-owner-v1', '1')
    localStorage.setItem('filaman-label-presets-db-migrated-v1', 'complete')
    localStorage.setItem('filaman-spool-label-designer-v1', '{"assetId":"private"}')
    localStorage.setItem('filaman-label-designer-v1', '{"label":{"width":72}}')
    localStorage.setItem('filaman-label-presets-v1', JSON.stringify([{ name: 'Private legacy preset', settings: {} }]))
    clearLabelPresetBrowserStorage()
    const post = vi.spyOn(api, 'post').mockResolvedValue([])
    try {
      await hydrateLabelPresetStorage(2)
      expect(localStorage.getItem('filaman-spool-label-designer-v1')).toBeNull()
      expect(localStorage.getItem('filaman-label-designer-v1')).toBeNull()
      expect(readBrowserPresetsForMigration()).toEqual([])
    } finally {
      post.mockRestore()
      clearLabelPresetBrowserStorage()
    }
  })

  describe.each(['spool', 'filament'] as const)('%s browser fallback', kind => {
    it.each([
      ['array', 'save'], ['object', 'save'],
      ['array', 'update'], ['object', 'update'],
      ['array', 'rename'], ['object', 'rename'],
      ['array', 'delete'], ['object', 'delete'],
    ])('preserves unrelated V1 presets after failed migration then successful %s cache %s', async (format, operation) => {
      const key = `filaman-${kind}-label-presets-v1`
      const settings = { label: { width: 72 }, title: { template: 'Original custom text' } }
      const legacy = [
        { name: 'Original', settings },
        { name: 'Target', settings: { label: { width: 80 } } },
      ]
      const raw = JSON.stringify(format === 'array' ? legacy : { version: 1, presets: legacy })
      localStorage.setItem(key, raw)
      vi.spyOn(api, 'post').mockRejectedValue(new Error('Migration unavailable'))
      vi.spyOn(api, 'put').mockResolvedValue({})
      vi.spyOn(api, 'delete').mockResolvedValue({})
      vi.spyOn(console, 'warn').mockImplementation(() => {})

      await hydrateLabelPresetStorage(1)
      expect(localStorage.getItem(key)).toBe(raw)
      const stored = { name: operation === 'update' ? 'Target' : 'New', data: { version: 2 as const, design: createDefaultLabelDesign(kind) } }
      const presets = readStoredPresets(key).filter(preset => operation === 'save' || preset.name !== 'Target')
      if (operation !== 'delete') presets.push(stored)
      expect(await persistStoredPresetMutation(key, presets, () => operation === 'delete'
        ? deleteLabelPreset(key, 'Target')
        : saveLabelPreset(key, stored, operation === 'rename' ? 'Target' : undefined, operation === 'save'),
      )).toBe(true)

      const expectedNames = operation === 'save' ? ['Original', 'Target', 'New']
        : operation === 'delete' ? ['Original'] : ['Original', stored.name]
      const retained = readStoredPresets(key)
      expect(retained.map(preset => preset.name)).toEqual(expectedNames)
      expect(retained[0].data.legacy_v1).toEqual(settings)
      expect(retained[0].data.design.label.widthMm).toBe(72)
      expect(retained[0].data.design.elements.some(element => element.type === 'text' && element.template === 'Original custom text')).toBe(true)
      expect(needsBrowserPresetMigration()).toBe(true)
      expect(readBrowserPresetsForMigration().map(preset => preset.name)).toEqual(expectedNames)
    })

    it('keeps legacy fallback usable through a failed cache write and preserves its on-disk recovery copy', async () => {
      const key = `filaman-${kind}-label-presets-v1`
      const raw = JSON.stringify([{ name: 'Original', settings: { label: { width: 72 } } }])
      localStorage.setItem(key, raw)
      vi.spyOn(api, 'post').mockRejectedValue(new Error('Migration unavailable'))
      vi.spyOn(api, 'put').mockResolvedValue({})
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      await hydrateLabelPresetStorage(1)
      const setItem = localStorage.setItem
      vi.spyOn(localStorage, 'setItem').mockImplementation(function (this: Storage, name, value) {
        if (name === key) throw new DOMException('Quota exceeded', 'QuotaExceededError')
        return setItem.call(this, name, value)
      })
      const stored = { name: 'New', data: { version: 2 as const, design: createDefaultLabelDesign(kind) } }

      expect(await persistStoredPresetMutation(key, [...readStoredPresets(key), stored], () => saveLabelPreset(key, stored))).toBe(true)

      expect(readStoredPresets(key).map(preset => preset.name)).toEqual(['Original', 'New'])
      expect(readStoredPresets(key)[0].data.design.label.widthMm).toBe(72)
      expect(localStorage.getItem(key)).toBe(raw)
      expect(needsBrowserPresetMigration()).toBe(true)
      clearLabelPresetBrowserStorage()
      expect(readStoredPresets(key).map(preset => preset.name)).toEqual(['Original'])
      expect(localStorage.getItem(key)).toBe(raw)
    })
  })

  it.each(['save', 'update', 'rename', 'delete'])('retires the global alias after a successful merged cache %s without resurrecting its old names', async operation => {
    const key = 'filaman-spool-label-presets-v1'
    const alias = 'filaman-label-presets-v1'
    localStorage.setItem(key, JSON.stringify([{ name: 'Entity preset', settings: { label: { width: 70 } } }]))
    localStorage.setItem(alias, JSON.stringify({ version: 1, presets: [
      { name: 'Global preset', settings: { label: { width: 72 } } },
      { name: 'Target', settings: { label: { width: 80 } } },
    ] }))
    vi.spyOn(api, 'post').mockRejectedValue(new Error('Migration unavailable'))
    vi.spyOn(api, 'put').mockResolvedValue({})
    vi.spyOn(api, 'delete').mockResolvedValue({})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await hydrateLabelPresetStorage(1)
    const stored = { name: operation === 'update' ? 'Target' : 'New', data: { version: 2 as const, design: createDefaultLabelDesign('spool') } }
    const presets = readStoredPresets(key).filter(preset => operation === 'save' || preset.name !== 'Target')
    if (operation !== 'delete') presets.push(stored)

    expect(await persistStoredPresetMutation(key, presets, () => operation === 'delete'
      ? deleteLabelPreset(key, 'Target')
      : saveLabelPreset(key, stored, operation === 'rename' ? 'Target' : undefined),
    )).toBe(true)

    const expectedNames = operation === 'save' ? ['Entity preset', 'Global preset', 'Target', 'New']
      : operation === 'delete' ? ['Entity preset', 'Global preset'] : ['Entity preset', 'Global preset', stored.name]
    expect(readStoredPresets(key).map(preset => preset.name)).toEqual(expectedNames)
    expect(readBrowserPresetsForMigration().map(preset => preset.name)).toEqual(expectedNames)
    expect(localStorage.getItem(alias)).toBeNull()
  })

  it('retains unsupported browser entries when a supported preset is saved and later hydrated', async () => {
    const key = 'filaman-spool-label-presets-v1'
    const future = { name: 'Future', data: { version: 3, design: { version: 3, custom: 'recover me' } } }
    localStorage.setItem(key, JSON.stringify({ version: 2, presets: [future] }))
    const stored = { name: 'New', data: { version: 2 as const, design: createDefaultLabelDesign('spool') } }
    vi.spyOn(api, 'put').mockResolvedValue({})

    expect(await persistStoredPresetMutation(key, [stored], () => saveLabelPreset(key, stored))).toBe(true)
    expect(JSON.parse(localStorage.getItem(key)!).presets).toContainEqual(future)
    expect(readStoredPresets(key).map(preset => preset.name)).toEqual(['New'])

    localStorage.setItem('filaman-label-presets-db-migrated-v1', 'complete')
    vi.spyOn(api, 'get').mockResolvedValue([{ id: 1, preset_type: 'spool', ...stored }])
    await hydrateLabelPresetStorage(1)

    expect(JSON.parse(localStorage.getItem(key)!).presets).toContainEqual(future)
    expect(readStoredPresets(key).map(preset => preset.name)).toEqual(['New'])
    clearLabelPresetBrowserStorage()
    expect(JSON.parse(localStorage.getItem(key)!).presets).toEqual([future])
  })

  it.each([false, true])('preserves unsupported global alias data through migration when cache quota fails: %s', async quotaFails => {
    const key = 'filaman-spool-label-presets-v1'
    const alias = 'filaman-label-presets-v1'
    const future = { name: 'Future', data: { version: 3, design: { version: 3, custom: 'recover me' } } }
    const raw = JSON.stringify([{ name: 'Legacy', settings: { label: { width: 72 } } }, future])
    localStorage.setItem(alias, raw)
    vi.spyOn(api, 'post').mockResolvedValue([{
      id: 1, preset_type: 'spool', name: 'Legacy', data: { settings: { label: { width: 72 } } },
    }])
    if (quotaFails) {
      const setItem = localStorage.setItem
      vi.spyOn(localStorage, 'setItem').mockImplementation(function (this: Storage, name, value) {
        if (name === key) throw new DOMException('Quota exceeded', 'QuotaExceededError')
        return setItem.call(this, name, value)
      })
    }

    await hydrateLabelPresetStorage(1)

    expect(readStoredPresets(key).map(preset => preset.name)).toEqual(['Legacy'])
    expect(readStoredPresets(key)[0].data.design.label.widthMm).toBe(72)
    expect(needsBrowserPresetMigration()).toBe(false)
    if (quotaFails) {
      expect(localStorage.getItem(alias)).toBe(raw)
      expect(localStorage.getItem(key)).toBeNull()
    } else {
      expect(localStorage.getItem(alias)).toBeNull()
      expect(JSON.parse(localStorage.getItem(key)!).presets).toContainEqual(future)
    }
  })

  it('keeps an unsupported cache envelope recoverable across consecutive writes and hydration', async () => {
    const key = 'filaman-spool-label-presets-v1'
    const raw = JSON.stringify({ version: 3, custom: { opaque: 'recover the complete source' } })
    localStorage.setItem(key, raw)
    vi.spyOn(api, 'put').mockResolvedValue({})
    const first = { name: 'First', data: { version: 2 as const, design: createDefaultLabelDesign('spool') } }
    const second = { ...first, name: 'Second' }

    expect(await persistStoredPresetMutation(key, [first], () => saveLabelPreset(key, first))).toBe(true)
    expect(await persistStoredPresetMutation(key, [...readStoredPresets(key), second], () => saveLabelPreset(key, second))).toBe(true)
    expect(readStoredPresets(key).map(preset => preset.name)).toEqual(['First', 'Second'])
    expect(localStorage.getItem(key)).toBe(raw)

    localStorage.setItem('filaman-label-presets-db-migrated-v1', 'complete')
    vi.spyOn(api, 'get').mockResolvedValue([{ id: 1, preset_type: 'spool', ...first }, { id: 2, preset_type: 'spool', ...second }])
    await hydrateLabelPresetStorage(1)
    expect(readStoredPresets(key).map(preset => preset.name)).toEqual(['First', 'Second'])
    expect(localStorage.getItem(key)).toBe(raw)
    clearLabelPresetBrowserStorage()
    expect(localStorage.getItem(key)).toBe(raw)
    vi.spyOn(api, 'post').mockResolvedValue([])
    await hydrateLabelPresetStorage(2)
    expect(localStorage.getItem(key)).not.toBe(raw)
    expect(readStoredPresets(key)).toEqual([])
  })

  it('saves to the database and keeps the preset visible when browser cache reads and writes fail', async () => {
    const key = 'filaman-spool-label-presets-v1'
    const design = createDefaultLabelDesign('spool')
    const stored = { name: 'Saved', data: { version: 2 as const, design } }
    const originalSetItem = localStorage.setItem
    const originalGetItem = localStorage.getItem
    const getItem = vi.spyOn(localStorage, 'getItem').mockImplementation(function (this: Storage, name) {
      if (name === key) throw new DOMException('Storage blocked', 'SecurityError')
      return originalGetItem.call(this, name)
    })
    const setItem = vi.spyOn(localStorage, 'setItem').mockImplementation(function (this: Storage, name, value) {
      if (name === key) throw new DOMException('Quota exceeded', 'QuotaExceededError')
      return originalSetItem.call(this, name, value)
    })
    const save = vi.fn(async () => true)
    try {
      expect(await persistStoredPresetMutation(key, [stored], save)).toBe(true)
      expect(save).toHaveBeenCalledOnce()
      expect(readStoredPresets(key).map(preset => preset.name)).toEqual(['Saved'])
    } finally {
      getItem.mockRestore()
      setItem.mockRestore()
      clearLabelPresetBrowserStorage()
    }
  })

  it('keeps database presets available when browser cache hydration hits quota', async () => {
    const key = 'filaman-spool-label-presets-v1'
    localStorage.setItem('filaman-label-presets-owner-v1', '2')
    localStorage.setItem('filaman-label-presets-db-migrated-v1', 'complete')
    const get = vi.spyOn(api, 'get').mockResolvedValue([{
      id: 1, preset_type: 'spool', name: 'Database preset',
      data: { version: 2, design: createDefaultLabelDesign('spool') },
    }])
    const originalSetItem = localStorage.setItem
    const setItem = vi.spyOn(localStorage, 'setItem').mockImplementation(function (this: Storage, name, value) {
      if (name === key) throw new DOMException('Quota exceeded', 'QuotaExceededError')
      return originalSetItem.call(this, name, value)
    })
    try {
      await hydrateLabelPresetStorage(2)
      expect(readStoredPresets(key).map(preset => preset.name)).toEqual(['Database preset'])
    } finally {
      setItem.mockRestore()
      get.mockRestore()
      clearLabelPresetBrowserStorage()
    }
  })

  it('leaves the browser cache unchanged when a database mutation fails', async () => {
    const key = 'filaman-spool-label-presets-v1'
    const existing = { name: 'Existing', data: { version: 2 as const, design: createDefaultLabelDesign('spool') } }
    localStorage.setItem(key, JSON.stringify({ version: 2, presets: [existing] }))

    expect(await persistStoredPresetMutation(key, [], async () => false)).toBe(false)
    expect(readStoredPresets(key).map(preset => preset.name)).toEqual(['Existing'])
  })
  it('isolates unsupported presets and prevents overwriting them by name', async () => {
    const future = { version: 3, design: { version: 3, elements: [{ type: 'future' }] } }
    const original = structuredClone(future)
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const put = vi.spyOn(api, 'put').mockResolvedValue({})
    try {
      const cache = buildDesignerPresetCache([
        { id: 1, preset_type: 'spool', name: 'Future', data: future },
        { id: 2, preset_type: 'spool', name: 'Usable', data: { settings: { label: { width: 72 } } } },
      ], 'spool')
      expect(cache.presets.map(preset => preset.name)).toEqual(['Usable'])
      expect(cache.presets[0].data.design.label.widthMm).toBe(72)
      expect(future).toEqual(original)
      expect(warning).toHaveBeenCalled()
      expect(await saveLabelPreset('filaman-spool-label-presets-v1', { name: 'Future', settings: {} })).toBe(false)
      expect(put).not.toHaveBeenCalled()
    } finally {
      warning.mockRestore()
      put.mockRestore()
      buildDesignerPresetCache([], 'spool')
    }
  })

  it('exposes normalized v2 data while retaining the original legacy payload', () => {
    const legacy = {
      label: { width: 72, height: 35, marginMm: 2, border: true },
      title: { template: '{filament.name}' },
    }
    let nativeId = 0
    const nativeV2 = {
      version: 2 as const,
      design: createDefaultLabelDesign('spool', () => `native-${++nativeId}`),
    }

    const cache = buildDesignerPresetCache([
      { id: 1, preset_type: 'spool', name: 'Legacy', data: { settings: legacy } },
      { id: 2, preset_type: 'spool', name: 'Native', data: nativeV2 },
      { id: 3, preset_type: 'filament', name: 'Wrong kind', data: { settings: legacy } },
    ], 'spool')

    expect(cache.version).toBe(2)
    expect(cache.presets.map(preset => preset.name)).toEqual(['Legacy', 'Native'])
    expect(cache.presets[0].data).toMatchObject({ version: 2, legacy_v1: legacy })
    expect(cache.presets[0].data.design.label).toMatchObject({ widthMm: 72, heightMm: 35 })
    expect(cache.presets[1].data).toEqual(nativeV2)
  })

  it('saves native v2 designer data without changing the sheet or legacy API shapes', () => {
    let id = 0
    const data = {
      version: 2 as const,
      design: createDefaultLabelDesign('spool', () => `id-${++id}`),
    }

    expect(buildLabelPresetUpsertBody('filaman-spool-label-presets-v1', {
      name: 'Freeform',
      data,
    }, 'Old name')).toEqual({
      name: 'Freeform',
      previous_name: 'Old name',
      data,
    })
    expect(buildLabelPresetUpsertBody('filaman-filament-label-presets-v1', {
      name: 'Legacy',
      settings: { label: { width: 50 } },
    })).toEqual({
      name: 'Legacy',
      previous_name: undefined,
      data: { settings: { label: { width: 50 } } },
    })
    expect(buildLabelPresetUpsertBody('filaman-label-sheet-presets-v1', {
      id: 'sheet-id',
      name: 'Sheet',
      settings: { rows: 8 },
    })).toEqual({
      name: 'Sheet',
      previous_name: undefined,
      data: { id: 'sheet-id', settings: { rows: 8 } },
    })

    expect(buildLabelPresetUpsertBody('filaman-spool-label-presets-v1', {
      name: 'New preset',
      data,
    }, undefined, true)).toEqual({
      name: 'New preset',
      previous_name: undefined,
      create_only: true,
      data,
    })
  })
})
