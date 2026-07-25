export const SPOOL_LABEL_PRESETS_KEY = 'filaman-spool-label-presets-v1'
export const FILAMENT_LABEL_PRESETS_KEY = 'filaman-filament-label-presets-v1'
export const LABEL_SHEET_PRESETS_KEY = 'filaman-label-sheet-presets-v1'
export const LEGACY_SPOOL_LABEL_PRESETS_KEY = 'filaman-label-presets-v1'

const MIGRATION_KEY = 'filaman-label-presets-db-migrated-v1'

type LocalNamedPreset = {
  name: string
  settings: unknown
}

type LocalSheetPreset = LocalNamedPreset & {
  id: string
}

function safeRead(key: string): unknown {
  try {
    return JSON.parse(localStorage.getItem(key) || 'null')
  } catch {
    return null
  }
}

function readDesignerPresets(key: string): LocalNamedPreset[] {
  const raw = safeRead(key)
  const presets = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as { presets?: unknown }).presets)
      ? (raw as { presets: unknown[] }).presets
      : []
  return presets
    .filter((item): item is Record<string, unknown> => Boolean(
      item && typeof item === 'object' && typeof item.name === 'string' && item.settings,
    ))
    .map(item => ({ name: String(item.name).trim().slice(0, 120), settings: item.settings }))
    .filter(item => item.name.length > 0)
}

function readSheetPresets(): LocalSheetPreset[] {
  const raw = safeRead(LABEL_SHEET_PRESETS_KEY)
  if (!Array.isArray(raw)) return []
  return raw
    .filter((item): item is Record<string, unknown> => Boolean(
      item && typeof item === 'object' && typeof item.name === 'string' && item.settings,
    ))
    .map((item, index) => ({
      id: typeof item.id === 'string' && item.id ? item.id : `migrated-${index}`,
      name: String(item.name).trim().slice(0, 120),
      settings: item.settings,
    }))
    .filter(item => item.name.length > 0)
}

export function needsBrowserPresetMigration(): boolean {
  try {
    return localStorage.getItem(MIGRATION_KEY) !== 'complete'
  } catch {
    return false
  }
}

export function completeBrowserPresetMigration(): void {
  try {
    localStorage.setItem(MIGRATION_KEY, 'complete')
    localStorage.removeItem(LEGACY_SPOOL_LABEL_PRESETS_KEY)
  } catch {
    // Database hydration still works when browser storage is blocked.
  }
}

export function clearBrowserPresetMigrationState(): void {
  try {
    localStorage.removeItem(MIGRATION_KEY)
  } catch {
    // Storage can be unavailable in privacy modes; callers already handle no-cache operation.
  }
}

export function prepareLegacySpoolPresetFallback(): void {
  try {
    const legacyValue = localStorage.getItem(LEGACY_SPOOL_LABEL_PRESETS_KEY)
    if (legacyValue && !localStorage.getItem(SPOOL_LABEL_PRESETS_KEY)) {
      localStorage.setItem(SPOOL_LABEL_PRESETS_KEY, legacyValue)
    }
  } catch {
    // Browser storage is optional; the database request can still proceed.
  }
}

export function readBrowserPresetsForMigration() {
  const spoolPresets = [
    ...readDesignerPresets(SPOOL_LABEL_PRESETS_KEY),
    ...readDesignerPresets(LEGACY_SPOOL_LABEL_PRESETS_KEY),
  ]
  const uniqueSpoolPresets = spoolPresets.filter(
    (preset, index) => spoolPresets.findIndex(candidate => candidate.name === preset.name) === index,
  )
  return [
    ...uniqueSpoolPresets.map(preset => ({
      preset_type: 'spool' as const,
      name: preset.name,
      data: { settings: preset.settings },
    })),
    ...readDesignerPresets(FILAMENT_LABEL_PRESETS_KEY).map(preset => ({
      preset_type: 'filament' as const,
      name: preset.name,
      data: { settings: preset.settings },
    })),
    ...readSheetPresets().map(preset => ({
      preset_type: 'sheet' as const,
      name: preset.name,
      data: { id: preset.id, settings: preset.settings },
    })),
  ]
}
