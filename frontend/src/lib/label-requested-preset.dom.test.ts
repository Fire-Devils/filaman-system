// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { loadRequestedPrintLabel } from './label-print-workspace'
import { clearLabelPresetBrowserStorage, hydrateLabelPresetStorage } from './label-preset-storage'
import { readStoredPresets } from './freeform-label/editor-storage'
import { createDefaultLabelDesign } from './freeform-label/defaults'

afterEach(() => {
  clearLabelPresetBrowserStorage()
  localStorage.clear()
  vi.unstubAllGlobals()
})

it.each(['spool', 'filament'] as const)('requires a fresh %s preset for explicit print requests', async kind => {
  localStorage.setItem('filaman-label-presets-db-migrated-v1', 'complete')
  const key = `filaman-${kind}-label-presets-v1`
  const preset = { id: 42, name: 'Requested', preset_type: kind,
    data: { version: 2, design: createDefaultLabelDesign(kind) } }
  let offline = false
  vi.stubGlobal('fetch', async (url: string) => url.endsWith('/me')
    ? new Response(JSON.stringify({ id: 1 }))
    : offline ? new Response(null, { status: 503 }) : new Response(JSON.stringify([preset])))
  await hydrateLabelPresetStorage(1)
  preset.data.design.label.widthMm = 88
  let loadedWidth: number | undefined
  const editor = {
    refreshPresetList() {},
    loadPreset(name: string) {
      loadedWidth = readStoredPresets(key).find(item => item.name === name)?.data.design.label.widthMm
      return loadedWidth !== undefined
    },
  }
  await loadRequestedPrintLabel(editor as never, key, 42, { id: 1 })
  expect(loadedWidth).toBe(88)

  offline = true
  loadedWidth = undefined
  await expect(loadRequestedPrintLabel(editor as never, key, 42, { id: 1 })).rejects.toThrow()
  expect(loadedWidth).toBeUndefined()
})
