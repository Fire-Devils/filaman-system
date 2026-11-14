export const sidebarStorageKey = 'sidebar-preferences'
export const legacyColorKey = 'sidebar-color-library'
export const expandedStorageKey = 'sidebar-plugins-expanded'
export const sidebarSyncKey = 'sidebar-preferences-changed'
export const colorModeId = 'sidebar-color-mode'

export type ColorMode = 'brand' | 'light' | 'dark'

export interface SidebarItemPreference {
  id: string
  shown: boolean
  pinned?: boolean | null
}

export interface SidebarPreferences {
  navigation: SidebarItemPreference[]
  plugins: SidebarItemPreference[]
  compact: boolean
  hover: boolean
  remember: boolean
  showColorMode: boolean
}

export interface AccountSidebarPreferences {
  sidebar: SidebarPreferences | null
  theme: ColorMode | null
  expanded: boolean | null
}

export function defaultSidebarPreferences(): SidebarPreferences {
  return { navigation: [], plugins: [], compact: false, hover: true, remember: false, showColorMode: true }
}

export function readLegacySidebarPreferences(storage: Storage): SidebarPreferences | null {
  let saved: Partial<SidebarPreferences> | null = null
  try {
    saved = JSON.parse(storage.getItem(sidebarStorageKey) ?? 'null')
  } catch { /* Keep the default layout if storage is invalid. */ }
  if (!saved && storage.getItem(legacyColorKey) !== 'false') return null
  const validRows = (rows: SidebarItemPreference[] | undefined, limit: number): SidebarItemPreference[] =>
    Array.isArray(rows) ? rows.filter(row => typeof row?.id === 'string' && /^[A-Za-z0-9_/-]{1,128}$/.test(row.id))
      .slice(0, limit).map(row => ({ id: row.id, shown: row.shown !== false, pinned: row.pinned !== false })) : []
  const navigation = validRows(saved?.navigation, 128)
  if (storage.getItem(legacyColorKey) === 'false' && !navigation.some(row => row.id === '/filaments/colors')) {
    navigation.push({ id: '/filaments/colors', shown: false })
  }
  return {
    navigation,
    plugins: validRows(saved?.plugins, 512),
    compact: saved?.compact === true,
    hover: saved?.hover !== false,
    remember: saved?.remember === true,
    showColorMode: saved?.showColorMode !== false,
  }
}

export function arrangeSidebarItems<T extends { id: string }>(
  items: T[], preferences: SidebarItemPreference[],
): (T & { shown: boolean; pinned: boolean })[] {
  const remaining = new Map(items.map(item => [item.id, item]))
  const ordered: (T & { shown: boolean; pinned: boolean })[] = []
  for (const preference of preferences) {
    const item = remaining.get(preference?.id)
    if (!item) continue
    ordered.push({ ...item, shown: preference.shown !== false, pinned: preference.pinned !== false })
    remaining.delete(item.id)
  }
  return ordered.concat([...remaining.values()].map(item => ({ ...item, shown: true, pinned: true })))
}

export function mergeSidebarOrder(saved: SidebarItemPreference[], rows: SidebarItemPreference[]) {
  const available = new Set(rows.map(row => row.id))
  const seen = new Set<string>()
  let next = 0
  const merged: SidebarItemPreference[] = []
  // Fill the existing visible slots in editor order, keeping unavailable items in place.
  for (const row of saved) {
    if (!row?.id || seen.has(row.id)) continue
    seen.add(row.id)
    merged.push(available.has(row.id) ? rows[next++] : row)
  }
  return merged.concat(rows.slice(next))
}
