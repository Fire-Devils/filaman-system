import {
  clearBrowserPresetMigrationState,
  completeBrowserPresetMigration,
  FILAMENT_LABEL_PRESETS_KEY,
  LABEL_SHEET_PRESETS_KEY,
  needsBrowserPresetMigration,
  prepareLegacySpoolPresetFallback,
  readBrowserPresetsForMigration,
  SPOOL_LABEL_PRESETS_KEY,
} from './label-preset-browser-migration'
import { api } from './api'

export {
  FILAMENT_LABEL_PRESETS_KEY,
  LABEL_SHEET_PRESETS_KEY,
  SPOOL_LABEL_PRESETS_KEY,
} from './label-preset-browser-migration'

type PresetType = 'spool' | 'filament' | 'sheet'

type ApiLabelPreset = {
  id: number
  preset_type: PresetType
  name: string
  data: Record<string, unknown>
}

let hydrationPromise: Promise<void> | null = null
const PRESET_OWNER_KEY = 'filaman-label-presets-owner-v1'

function safeWrite(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value))
    return true
  } catch {
    return false
  }
}

function writeDatabasePresetsToBrowser(presets: ApiLabelPreset[]) {
  const designerPayload = (presetType: 'spool' | 'filament') => ({
    version: 1,
    presets: presets
      .filter(preset => preset.preset_type === presetType && preset.data.settings)
      .map(preset => ({ name: preset.name, settings: preset.data.settings })),
  })
  safeWrite(SPOOL_LABEL_PRESETS_KEY, designerPayload('spool'))
  safeWrite(FILAMENT_LABEL_PRESETS_KEY, designerPayload('filament'))
  safeWrite(LABEL_SHEET_PRESETS_KEY, presets
    .filter(preset => preset.preset_type === 'sheet' && preset.data.settings)
    .map(preset => ({
      id: typeof preset.data.id === 'string' ? preset.data.id : `database-${preset.id}`,
      name: preset.name,
      settings: preset.data.settings,
    })))
}

async function fetchPresetDatabase(): Promise<ApiLabelPreset[]> {
  const needsMigration = needsBrowserPresetMigration()
  if (needsMigration) prepareLegacySpoolPresetFallback()
  const presets = needsMigration
    ? await api.post<ApiLabelPreset[]>('/me/label-presets/migrate', {
        presets: readBrowserPresetsForMigration(),
      })
    : await api.get<ApiLabelPreset[]>('/me/label-presets')
  if (needsMigration) completeBrowserPresetMigration()
  return presets
}

function removePresetBrowserValues(clearMigrationState = true) {
  for (const key of [
    SPOOL_LABEL_PRESETS_KEY,
    FILAMENT_LABEL_PRESETS_KEY,
    LABEL_SHEET_PRESETS_KEY,
  ]) {
    try {
      localStorage.removeItem(key)
    } catch {
      // Browser storage is an optional cache.
    }
  }
  if (clearMigrationState) clearBrowserPresetMigrationState()
}

function preparePresetOwner(userId: number) {
  const nextOwner = String(userId)
  let previousOwner: string | null = null
  try {
    previousOwner = localStorage.getItem(PRESET_OWNER_KEY)
  } catch {
    return
  }
  // No marker means these may be legacy browser-only presets awaiting first migration.
  if (previousOwner !== null && previousOwner !== nextOwner) removePresetBrowserValues()
  try {
    localStorage.setItem(PRESET_OWNER_KEY, nextOwner)
  } catch {
    // Database persistence still works without a browser cache.
  }
}

export function clearLabelPresetBrowserStorage() {
  // Preserve legacy browser-only presets when their database migration has not succeeded yet.
  if (needsBrowserPresetMigration()) {
    hydrationPromise = null
    return
  }
  // Keep the owner and completed migration marker. A subsequent login by the same
  // account can skip migration; a different account is detected and reset above.
  removePresetBrowserValues(false)
  hydrationPromise = null
}

export async function ensureLabelPresetBrowserMigration(userId: number): Promise<void> {
  if (!needsBrowserPresetMigration()) return
  await hydrateLabelPresetStorage(userId)
}

export function hydrateLabelPresetStorage(userId?: number): Promise<void> {
  if (!hydrationPromise) {
    const resolvedUserId = userId === undefined
      ? api.get<{ id: number }>('/me').then(user => user.id)
      : Promise.resolve(userId)
    hydrationPromise = resolvedUserId
      .then(id => {
        preparePresetOwner(id)
        return fetchPresetDatabase()
      })
      .then(writeDatabasePresetsToBrowser)
      .catch((error) => {
        hydrationPromise = null
        console.warn('Could not load label presets from the database; using browser fallback', error)
      })
  }
  return hydrationPromise
}

function presetTypeForStorageKey(storageKey: string): PresetType | null {
  if (storageKey === SPOOL_LABEL_PRESETS_KEY) return 'spool'
  if (storageKey === FILAMENT_LABEL_PRESETS_KEY) return 'filament'
  if (storageKey === LABEL_SHEET_PRESETS_KEY) return 'sheet'
  return null
}

export async function saveLabelPreset(
  storageKey: string,
  preset: { name: string; settings: unknown; id?: string },
  previousName?: string,
): Promise<boolean> {
  const presetType = presetTypeForStorageKey(storageKey)
  if (!presetType) return false
  try {
    await api.put<ApiLabelPreset>(`/me/label-presets/${presetType}/item`, {
      name: preset.name,
      previous_name: previousName,
      data: presetType === 'sheet'
        ? { id: preset.id, settings: preset.settings }
        : { settings: preset.settings },
    })
    return true
  } catch (error) {
    console.warn('Could not save label presets to the database', error)
    return false
  }
}

export async function deleteLabelPreset(storageKey: string, name: string): Promise<boolean> {
  const presetType = presetTypeForStorageKey(storageKey)
  if (!presetType) return false
  try {
    await api.delete(`/me/label-presets/${presetType}/item?name=${encodeURIComponent(name)}`)
    return true
  } catch (error) {
    console.warn('Could not delete label preset from the database', error)
    return false
  }
}
