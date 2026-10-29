// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { prepareExtraFieldUpdate, type EntityExtraFieldPayload } from './entity-extra-fields'

afterEach(() => vi.unstubAllGlobals())
const payload = (customFields: Record<string, unknown> | null): EntityExtraFieldPayload => ({ customFields, customFieldDefinitions: null })

it.each([
  { latest: { bambu_profile_base_name: 'Matte PLA', bambu_profiles_by_model: { X1C: { base_name: 'Matte PLA', source: 'override' } } } },
  { latest: { bambu_profile_base_name: 'Generic PLA', bambu_profiles_by_model: { X1C: { base_name: 'Generic PLA', source: 'default' } } } },
  { latest: {} },
  { latest: { bambu_slicer_filament: 'GFA00', bambu_slicer_filament_name: 'Matte PLA', new_plugin_key: 'new' } },
])('preserves a separately committed profile set/clear while saving an unrelated field ($latest)', async ({ latest }) => {
  const baseline = payload({ note: 'Dry', bambu_profile_base_name: 'Old', bambu_profiles_by_model: { X1C: { base_name: 'Old', source: 'override' } }, bambu_slicer_filament: 'OLD', bambu_slicer_filament_name: 'Old' })
  vi.stubGlobal('fetch', async () => Response.json({ custom_fields: { ...latest, note: 'Dry' } }))
  const update = await prepareExtraFieldUpdate('/spools/17', baseline, payload({ ...baseline.customFields, note: 'Wet' }))
  expect(update).toEqual({ custom_fields: { ...latest, note: 'Wet' } })
  expect(baseline.customFields?.note).toBe('Dry')
})

it('omits untouched JSON columns and avoids a read when only native fields changed', async () => {
  vi.stubGlobal('fetch', () => { throw new Error('Unnecessary request') })
  const baseline = payload({ plugin: { idx: '1' } })
  expect(await prepareExtraFieldUpdate('/filaments/16', baseline, payload({ plugin: { idx: '1' } }))).toEqual({})
})

it('applies nested additions, edits and deletion without losing new sibling data or typed values', async () => {
  vi.stubGlobal('fetch', async () => Response.json({
    custom_fields: { nested: { note: 'Dry', removed: 'old', driver: 42 }, zero: 0, flags: [false], extra: true },
    custom_field_definitions: { old: { label: 'Old', field_type: 'text' }, plugin: { label: 'Plugin', field_type: 'number' } },
  }))
  const baseline = { customFields: { nested: { note: 'Dry', removed: 'old' }, zero: '0', flags: [false] }, customFieldDefinitions: { old: { label: 'Old', field_type: 'text' } } }
  const draft = { customFields: { nested: { note: 'Wet', added: null }, zero: '0', flags: [true] }, customFieldDefinitions: { added: { label: 'Added', field_type: 'text' } } }
  expect(await prepareExtraFieldUpdate('/spools/17', baseline, draft)).toEqual({
    custom_fields: { nested: { note: 'Wet', added: null, driver: 42 }, zero: 0, flags: [true], extra: true },
    custom_field_definitions: { added: { label: 'Added', field_type: 'text' }, plugin: { label: 'Plugin', field_type: 'number' } },
  })
})

it('preserves a failed draft and refuses to write blind after its refresh fails', async () => {
  vi.stubGlobal('fetch', async () => Response.json({ detail: 'Offline' }, { status: 503 }))
  const draft = payload({ note: 'Wet' })
  await expect(prepareExtraFieldUpdate('/spools/17', payload({ note: 'Dry' }), draft)).rejects.toThrow('Offline')
  expect(draft.customFields).toEqual({ note: 'Wet' })
})
