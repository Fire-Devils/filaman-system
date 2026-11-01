import { describe, expect, it } from 'vitest'
import { catalogLinks, catalogSnapshot, filamentDbSource, profileFields, withManufacturerMetadata } from './manufacturer-catalog'

describe('manufacturer catalog metadata', () => {
  it('maps all catalog fields without inventing local spool defaults', () => {
    const source = filamentDbSource()
    const entry = source.normalize({ id: 119, slug: 'bambu-lab', name: 'Bambu Lab', website: 'https://bambulab.com/', description: null, contact_email: 'support@example.test', is_active: true, is_verified: false, filament_count: 659, has_web_logo: true, has_label_logo: true, created_at: 'a', updated_at: 'b' })
    expect(entry).toMatchObject({ id: 119, name: 'Bambu Lab', website: 'https://bambulab.com/', contact_email: 'support@example.test' })
    expect(entry.details).toMatchObject({ slug: 'bambu-lab', is_verified: false, filament_count: 659, created_at: 'a', updated_at: 'b' })
    expect(entry).not.toHaveProperty('empty_spool_weight_g')
  })

  it('keeps legacy links, other providers and unrelated custom fields on save', () => {
    const original = { filamentdb_id: 119, vendor: ['a'], catalog_sources: { other: { id: 'x' } } }
    expect(catalogLinks(original)).toMatchObject({ filamentdb: { id: 119 }, other: { id: 'x' } })
    const fields = withManufacturerMetadata(original, { contact_email: 'a@b.test', description: 'Ö <test>' }, catalogLinks(original))
    expect(fields).toMatchObject({ vendor: ['a'], filamentdb_id: 119, manufacturer_profile: { description: 'Ö <test>' }, catalog_sources: { other: { id: 'x' }, filamentdb: { id: 119 } } })
    expect(profileFields(fields).contact_email).toBe('a@b.test')
    expect(original).not.toHaveProperty('manufacturer_profile')
  })
})

it('ignores malformed snapshots without discarding their stored metadata', () => {
  const fields = { catalog_sources: { other: { id: 'a', snapshot: { name: 42 }, unknown: true } } }
  expect(catalogSnapshot(catalogLinks(fields).other.snapshot)).toBeUndefined()
  expect(catalogLinks(fields).other).toEqual(fields.catalog_sources.other)
})

it('colors the catalog availability status without assigning verification to the local app', () => {
  const source = filamentDbSource()
  const active = source.normalize({ id: 1, name: 'Maker', is_active: true, is_verified: false })
  const inactive = source.normalize({ id: 1, name: 'Maker', is_active: false, is_verified: true })
  expect(source.summary!(active)[0]).toMatchObject({ tone: 'success' })
  expect(source.summary!(inactive)[0]).toMatchObject({ tone: 'warning' })
  expect(source.summary!(active)[1]).toBe('Not verified')
})
