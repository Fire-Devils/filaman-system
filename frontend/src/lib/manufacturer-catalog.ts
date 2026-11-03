import { request } from './api'
import { t } from './i18n'

export type ManufacturerProfile = { contact_email: string; description: string }
export type CatalogEntry = ManufacturerProfile & {
  id: string | number
  name: string
  website: string
  logo_url?: string
  label_logo_url?: string
  details: Record<string, unknown>
}
export type CatalogLink = { id: string | number; snapshot?: CatalogEntry }
export type CatalogLinks = Record<string, CatalogLink>

// Providers own lookup/mapping/logo behavior; the dialog only consumes this shape.
export interface ManufacturerSource {
  key: string
  label: string
  endpoint: string
  normalize: (raw: Record<string, unknown>) => CatalogEntry
  load: (id: string | number, signal: AbortSignal) => Promise<CatalogEntry>
  summary?: (entry: CatalogEntry) => Array<string | { label: string; tone: 'success' | 'warning' }>
  saveLogo?: (manufacturerId: number, entry: CatalogEntry) => Promise<void>
}
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const text = (value: unknown): string => typeof value === 'string' ? value : ''

export function profileFields(fields: unknown): ManufacturerProfile {
  const profile = object(object(fields).manufacturer_profile)
  return { contact_email: text(profile.contact_email), description: text(profile.description) }
}

export function catalogSnapshot(value: unknown): CatalogEntry | undefined {
  const record = object(value)
  if ((typeof record.id !== 'string' && typeof record.id !== 'number') || typeof record.name !== 'string') return undefined
  return { ...record, id: record.id, name: record.name, website: text(record.website),
    contact_email: text(record.contact_email), description: text(record.description),
    logo_url: text(record.logo_url) || undefined, label_logo_url: text(record.label_logo_url) || undefined,
    details: object(record.details) }
}

export function catalogLinks(fields: unknown): CatalogLinks {
  const metadata = object(fields)
  const links = Object.fromEntries(Object.entries(object(metadata.catalog_sources)).filter(([, link]) => {
    const id = object(link).id
    return typeof id === 'string' || typeof id === 'number'
  })) as CatalogLinks
  if (!links.filamentdb && (typeof metadata.filamentdb_id === 'number' || typeof metadata.filamentdb_id === 'string')) links.filamentdb = { id: metadata.filamentdb_id }
  return links
}

export function withManufacturerMetadata(fields: unknown, profile: ManufacturerProfile, links: CatalogLinks): Record<string, unknown> {
  const original = object(fields)
  return { ...original, ...(links.filamentdb ? { filamentdb_id: links.filamentdb.id } : {}), manufacturer_profile: { ...object(original.manufacturer_profile), ...profile }, catalog_sources: { ...object(original.catalog_sources), ...links } }
}

export function filamentDbSource(): ManufacturerSource {
  const normalize = (raw: Record<string, unknown>): CatalogEntry => {
    if ((typeof raw.id !== 'number' && typeof raw.id !== 'string') || !text(raw.name)) throw new Error('Invalid manufacturer record')
    const slug = text(raw.slug)
    const logo = (kind: string) => `/api/v1/filamentdb/manufacturer-logos/${encodeURIComponent(slug)}/${kind}`
    return {
      id: raw.id, name: text(raw.name), website: text(raw.website), contact_email: text(raw.contact_email), description: text(raw.description),
      logo_url: raw.has_web_logo && slug ? logo('web') : undefined,
      label_logo_url: raw.has_label_logo && slug ? logo('label') : undefined,
      details: Object.fromEntries(Object.entries(raw).filter(([key]) => !['name', 'website', 'contact_email', 'description'].includes(key))),
    }
  }
  return {
    key: 'filamentdb', label: 'FilaManDB', endpoint: '/filamentdb/manufacturers', normalize,
    load: async (id, signal) => normalize(await request(`/filamentdb/manufacturers/${encodeURIComponent(id)}`, { signal })),
    summary: entry => [
      { label: t(entry.details.is_active ? 'manufacturers.catalog.active' : 'manufacturers.catalog.inactive'), tone: entry.details.is_active ? 'success' : 'warning' },
      t(entry.details.is_verified ? 'manufacturers.catalog.verified' : 'manufacturers.catalog.notVerified'),
      `${entry.details.filament_count ?? '–'} ${t('manufacturers.filaments')}`,
    ],
    saveLogo: async (id, entry) => {
      if (!entry.logo_url && !entry.label_logo_url) return
      await request(`/manufacturers/${id}/download-logo`, { method: 'POST', body: JSON.stringify({ slug: entry.details.slug, has_web_logo: !!entry.logo_url, has_label_logo: !!entry.label_logo_url }) })
    },
  }
}
