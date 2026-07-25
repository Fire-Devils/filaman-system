import { fetchAllPages } from './api'

type NamedLookupItem = {
  id?: unknown
  label?: unknown
  name?: unknown
}

type SpoolWithRelations = {
  location_id?: unknown
  status_id?: unknown
  location?: NamedLookupItem | null
  status?: NamedLookupItem | null
}

export interface SpoolLabelLookups {
  locationsById: ReadonlyMap<string, string>
  statusesById: ReadonlyMap<string, string>
}

export const EMPTY_SPOOL_LABEL_LOOKUPS: SpoolLabelLookups = {
  locationsById: new Map(),
  statusesById: new Map(),
}

function toLookupKey(value: unknown): string {
  return value === undefined || value === null ? '' : String(value)
}

function toLabelValue(value: unknown): string {
  return value === undefined || value === null ? '' : String(value).trim()
}

function buildNameMap(items: NamedLookupItem[], field: 'label' | 'name'): ReadonlyMap<string, string> {
  const result = new Map<string, string>()
  for (const item of items) {
    const key = toLookupKey(item?.id)
    const value = toLabelValue(item?.[field])
    if (key && value) result.set(key, value)
  }
  return result
}

export function createSpoolLabelLookups(
  locations: NamedLookupItem[] = [],
  statuses: NamedLookupItem[] = [],
): SpoolLabelLookups {
  return {
    locationsById: buildNameMap(locations, 'name'),
    statusesById: buildNameMap(statuses, 'label'),
  }
}

export function resolveSpoolLabelRelations(
  spool: SpoolWithRelations,
  lookups: SpoolLabelLookups = EMPTY_SPOOL_LABEL_LOOKUPS,
): { location: string; status: string } {
  const location = toLabelValue(spool?.location?.label)
    || toLabelValue(spool?.location?.name)
    || lookups.locationsById.get(toLookupKey(spool?.location_id))
    || ''
  const status = toLabelValue(spool?.status?.label)
    || toLabelValue(spool?.status?.name)
    || lookups.statusesById.get(toLookupKey(spool?.status_id))
    || ''
  return { location, status }
}

export async function loadSpoolLabelLookups(): Promise<SpoolLabelLookups> {
  const [locationsResult, statusesResult] = await Promise.allSettled([
    fetchAllPages<NamedLookupItem>('/api/v1/locations'),
    fetch('/api/v1/spools/statuses', { credentials: 'include' }).then(async response => {
      if (!response.ok) throw new Error(`Failed to load spool statuses: ${response.status}`)
      const data = await response.json()
      return Array.isArray(data) ? data as NamedLookupItem[] : []
    }),
  ])

  return createSpoolLabelLookups(
    locationsResult.status === 'fulfilled' ? locationsResult.value.items : [],
    statusesResult.status === 'fulfilled' ? statusesResult.value : [],
  )
}
