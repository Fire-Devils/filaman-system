import { createDefaultLabelDesign } from './defaults'
import { getStandardLabelPresets } from './standard-presets'
import { migrateV1PresetData, normalizeDesignerPresetData, normalizePresetDesign } from './migrate-v1'
import { FILAMENT_LABEL_PRESETS_KEY, LEGACY_SPOOL_LABEL_PRESETS_KEY, needsBrowserPresetMigration, SPOOL_LABEL_PRESETS_KEY } from '../label-preset-browser-migration'
import type { FreeformEditorController } from './editor-state'
import type { LabelDesignV2, LabelDesignerPresetData, LabelKind } from './types'

export const activeEditors = new Map<string, FreeformEditorController>()
const transientPresetCache = new Map<string, object>()

export function setTransientPresetCache(key: string, value: object | null) {
  if (value) transientPresetCache.set(key, value)
  else transientPresetCache.delete(key)
}

function readJsonObject(key: string, fallbackKey?: string): Record<string, unknown> | null {
  try {
    const raw = localStorage.getItem(key) ?? (fallbackKey ? localStorage.getItem(fallbackKey) : null)
    const parsed = JSON.parse(raw ?? '')
    if (Array.isArray(parsed)) return { presets: parsed }
    return parsed && typeof parsed === 'object'
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

export function persistFreeformLabelDesign(settingsKey: string, design: LabelDesignV2) {
  try {
    localStorage.setItem(settingsKey, JSON.stringify({ version: 2, design }))
    return true
  } catch {
    return false
  }
}

export function loadStoredFreeformLabelDesign(options: {
  settingsKey: string
  presetsKey: string
  kind: LabelKind
}): LabelDesignV2 {
  const working = readJsonObject(options.settingsKey, options.kind === 'spool' ? 'filaman-label-designer-v1' : undefined)
  if (working?.version === 2 && working.design) {
    return normalizePresetDesign(working.design)
  }
  if ((working?.version === 1 && working.settings) || (working?.version === undefined && working?.label)) {
    return migrateV1PresetData(working, options.kind).design
  }

  return readStoredPresets(options.presetsKey).find(preset => preset.name === 'Default')?.data.design
    ?? createDefaultLabelDesign(options.kind)
}

export function loadFreeformLabelDesign(options: {
  settingsKey: string
  presetsKey: string
  kind: LabelKind
}): LabelDesignV2 {
  const active = activeEditors.get(options.settingsKey)
  return active?.getDesign() ?? loadStoredFreeformLabelDesign(options)
}

export interface StoredPreset {
  name: string
  data: LabelDesignerPresetData
}

function isUnsupportedPresetCache(value: Record<string, unknown> | null) {
  return value?.version !== undefined && ![0, 1, 2].includes(value.version as number)
}

function readPresetCandidates(storageKey: string): unknown[] {
  const transient = transientPresetCache.get(storageKey) as Record<string, unknown> | undefined
  const sources = [transient ?? readJsonObject(storageKey)]
  if (!transient && storageKey === SPOOL_LABEL_PRESETS_KEY && needsBrowserPresetMigration()) {
    sources.push(readJsonObject(LEGACY_SPOOL_LABEL_PRESETS_KEY))
  }
  return sources.flatMap(value => !isUnsupportedPresetCache(value) && Array.isArray(value?.presets) ? value.presets : [])
}

function normalizeStoredPreset(candidate: unknown, storageKey: string): StoredPreset | null {
  if (!candidate || typeof candidate !== 'object') return null
  const { name, data, settings } = candidate as { name?: unknown; data?: unknown; settings?: unknown }
  if (typeof name !== 'string' || !name.trim()) return null
  const payload = data ?? (settings ? { settings } : null)
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  try {
    return {
      name: name.trim().slice(0, 120),
      data: normalizeDesignerPresetData(payload, storageKey === FILAMENT_LABEL_PRESETS_KEY ? 'filament' : 'spool'),
    }
  } catch {
    return null
  }
}

export function readStoredPresets(storageKey: string): StoredPreset[] {
  // Failed migration leaves V1 entries here; retain them in every whole-cache mutation.
  const presets = new Map<string, StoredPreset>()
  for (const candidate of readPresetCandidates(storageKey)) {
    const preset = normalizeStoredPreset(candidate, storageKey)
    if (preset && !presets.has(preset.name)) presets.set(preset.name, preset)
  }
  return [...presets.values()]
}

export function getFreeformLabelPresetNames(storageKey: string) {
  return [...new Set([
    ...readStoredPresets(storageKey).map(preset => preset.name),
    ...getStandardLabelPresets().map(preset => preset.name),
  ])]
}

export function loadFreeformLabelPresetDesign(options: {
  presetsKey: string
  presetName: string
  kind: LabelKind
}): LabelDesignV2 | null {
  const preset = readStoredPresets(options.presetsKey)
    .find(candidate => candidate.name === options.presetName)
    ?? getStandardLabelPresets().find(candidate => candidate.name === options.presetName)
  return preset ? normalizePresetDesign(preset.data.design) : null
}

export function writeStoredPresets(storageKey: string, presets: StoredPreset[]) {
  const unsupported = readPresetCandidates(storageKey).filter(candidate => !normalizeStoredPreset(candidate, storageKey))
  const value = { version: 2, presets: [...presets, ...unsupported] }
  // Keep an unknown envelope intact on disk; database-backed edits can use the transient cache.
  if (isUnsupportedPresetCache(readJsonObject(storageKey))) {
    setTransientPresetCache(storageKey, value)
    return
  }
  try {
    localStorage.setItem(storageKey, JSON.stringify(value))
    setTransientPresetCache(storageKey, null)
    if (storageKey === SPOOL_LABEL_PRESETS_KEY && needsBrowserPresetMigration()
      && !isUnsupportedPresetCache(readJsonObject(LEGACY_SPOOL_LABEL_PRESETS_KEY))) {
      localStorage.removeItem(LEGACY_SPOOL_LABEL_PRESETS_KEY)
    }
  } catch {
    setTransientPresetCache(storageKey, value)
  }
}

export async function persistStoredPresetMutation(
  storageKey: string,
  presets: StoredPreset[],
  mutateDatabase: () => Promise<boolean>,
) {
  try {
    if (!await mutateDatabase()) return false
  } catch {
    return false
  }
  writeStoredPresets(storageKey, presets)
  return true
}
