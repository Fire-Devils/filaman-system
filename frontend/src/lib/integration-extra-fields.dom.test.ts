// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import {
  createEntityExtraFieldEditor,
  prepareExtraFieldUpdate,
  renderDetailExtraFieldRows,
  type EntityExtraFieldPayload,
} from './entity-extra-fields'
import { createEntityExtraFieldsDialog } from './entity-extra-fields-dialog'
import { buildDesignerExtraFieldsFromFilament } from './filament-label-data'
import { buildLabelExtraFieldCatalogGroups, standardLabelExtraFields } from './label-extra-fields'

// Legacy import and image-cache metadata must retain objects, numbers, nulls and arrays.
const metadata = {
  filamentdb_id: 732,
  spoolman_id: 8,
  spoolman_external_id: 'bambulab_pla_bambugreen_1000_175_n',
  spoolman_extra: { bambu_profiles_by_model: { X1C: { flags: [false, 0], empty: {} } } },
  bambu_shop_source_url: 'https://example.com/product',
  bambu_shop_image_checked_at: '2026-11-01T19:39:11.474660+00:00',
  bambu_shop_image_url: 'https://example.com/image.jpg',
  bambu_image_resolver_version: 2,
  filament_image_source_url: 'https://example.com/product',
  filament_image_provider: 'bambulab',
  filament_image_checked_at: '2026-11-01T19:39:11.474660+00:00',
  filament_image_url: 'https://example.com/image.jpg',
  bambu_profile_base_name: null,
  bambu_profiles_by_model: { X1C: { base_name: 'PLA', source: 'override' } },
  bambu_slicer_filament: 'GFA00',
  bambu_slicer_filament_name: 'PLA',
  bambu_color_name: 'Green',
  bambu_rfid_tag_1: 'RFID1',
  bambu_rfid_tag_2: 'RFID2',
}
const definitions = {
  // A legacy definition must not turn integration metadata into a user field.
  filament_image_provider: { label: 'Image provider', field_type: 'text' },
  'drying.date': { label: 'Drying date', field_type: 'date', options: null, config: null },
}

afterEach(() => {
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

it('shows user fields and hides known integration metadata in detail rows', () => {
  const container = document.createElement('div')
  container.innerHTML = renderDetailExtraFieldRows({
    ...metadata, article_number: '10501', drying: { date: '2026-01-08' },
    notes: { spoolman_id: 'User reference' }, bambu_custom_note: 'My note',
  }, definitions, {
    article_number: { key: 'article_number', label: 'Article number', field_type: 'text' },
    bambu_image_resolver_version: { key: 'bambu_image_resolver_version', label: 'Resolver version', field_type: 'number' },
  }, 'System')
  expect([...container.querySelectorAll('.filament-spec-label')].map(label => label.textContent?.replace(/\s+/g, ' ').trim()))
    .toEqual(['Article number System', 'Drying date', 'notes.spoolman_id', 'bambu_custom_note'])
})

it('preserves hidden metadata while saving and removing user fields in the shared dialog', async () => {
  let saved: EntityExtraFieldPayload | undefined
  const dialog = createEntityExtraFieldsDialog({
    targetType: 'filament',
    systemFields: {
      article_number: { key: 'article_number', label: 'Article number', field_type: 'text' },
      bambu_image_resolver_version: { key: 'bambu_image_resolver_version', label: 'Resolver version', field_type: 'number' },
    },
    onSave: async payload => { saved = payload },
  })
  dialog.open({ customFields: { ...metadata, article_number: '10501', drying: { date: '2026-01-08' }, note: 'Remove me' }, customFieldDefinitions: definitions })
  const overlay = document.querySelector<HTMLDialogElement>('.entity-extra-fields-overlay')!
  expect([...overlay.querySelectorAll('tbody tr td:first-child')].map(cell => cell.textContent)).toEqual(['drying.date', 'note'])
  expect(overlay.querySelector<HTMLButtonElement>('[type="submit"]')!.disabled).toBe(true)
  vi.stubGlobal('__fmConfirm', async () => true)
  const noteRow = [...overlay.querySelectorAll('tbody tr')].find(row => row.firstElementChild?.textContent === 'note')!
  noteRow.querySelector<HTMLButtonElement>('.entity-extra-remove')!.click()
  await vi.waitFor(() => expect(overlay.querySelectorAll('tbody tr')).toHaveLength(1))
  const article = overlay.querySelector<HTMLInputElement>('.system-field-input')!
  article.value = '10502'
  article.dispatchEvent(new Event('input', { bubbles: true }))
  overlay.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }))
  await vi.waitFor(() => expect(overlay.open).toBe(false))
  expect(saved).toEqual({ customFields: { ...metadata, article_number: '10502', drying: { date: '2026-01-08' } }, customFieldDefinitions: definitions })
})

it('keeps metadata-only editor payloads lossless and clears them when another record opens', () => {
  const container = document.createElement('div'), addButton = document.createElement('button')
  document.body.append(container, addButton)
  const editor = createEntityExtraFieldEditor({ container, addButton, emptyText: 'No user fields' })
  editor.setData(metadata)
  expect(container.textContent).toBe('No user fields')
  expect(editor.getPayload()).toEqual({ customFields: metadata, customFieldDefinitions: null })
  editor.setData(null)
  expect(editor.getPayload()).toEqual({ customFields: null, customFieldDefinitions: null })
})

it('preserves independently refreshed metadata when saving a visible field', async () => {
  const baseline = { customFields: { ...metadata, note: 'Dry' }, customFieldDefinitions: null }
  vi.stubGlobal('fetch', async () => Response.json({ custom_fields: {
    ...metadata, bambu_image_resolver_version: 3, filament_image_url: null, note: 'Dry',
  } }))
  expect(await prepareExtraFieldUpdate('/filaments/8', baseline, {
    ...baseline, customFields: { ...metadata, note: 'Wet' },
  })).toEqual({ custom_fields: { ...metadata, bambu_image_resolver_version: 3, filament_image_url: null, note: 'Wet' } })
})

it('hides metadata label choices while preserving saved selections', () => {
  const filament = { id: 8, custom_fields: { ...metadata, article_number: '10501' } }
  const fields = buildDesignerExtraFieldsFromFilament(filament)
  expect(buildLabelExtraFieldCatalogGroups(fields, { entityType: 'filament', batchMode: false })
    .flatMap(group => group.fields).map(field => field.key)).toEqual(['filament.article_number'])
  expect(standardLabelExtraFields(fields, {}).map(field => field.key)).toEqual(['filament.article_number'])
  expect(standardLabelExtraFields(fields, { 'filament.spoolman_id': true }).map(field => field.key))
    .toEqual(['filament.spoolman_id', 'filament.article_number'])
})

it.each(['filament', 'spool'] as const)('hides metadata system controls in the full %s editor and preserves their stored values', async entity => {
  const { baseFilament, baseSpool, change, clearState, mockHttp, pageFixture } = await import('./detail-page-test-support')
  clearState()
  const http = mockHttp({
    filament: { ...baseFilament, custom_fields: { ...metadata, note: 'Dry' } },
    spool: { ...baseSpool, custom_fields: { ...metadata, note: 'Dry' } },
    system: [
      { key: 'note', label: 'Note', field_type: 'text' },
      { key: 'filament_image_provider', label: 'Image provider', field_type: 'text' },
    ],
  })
  const page = await pageFixture(entity, true)
  try {
    expect(document.querySelector('.system-field-input[data-key="filament_image_provider"]')).toBeNull()
    change('.system-field-input[data-key="note"]', 'Wet')
    document.querySelector(entity === 'filament' ? '#filament-form' : '#spool-inline-form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(http.calls.some(call => call.method === 'PATCH' && call.path.startsWith(`/api/v1/${entity}s/`))).toBe(true))
    expect((entity === 'filament' ? http.filament : http.spool).custom_fields).toEqual({ ...metadata, note: 'Wet' })
  } finally { page.dispose() }
})


it('keeps real legacy Spoolman extras visible while preserving only their hidden metadata', async () => {
  const customFields = {
    spoolman_id: 8,
    spoolman_extra: { tag: 'rack-a', note: 'User note', filament_image_provider: 'bambulab', bambu_image_resolver_version: 2 },
  }
  const container = document.createElement('div'), addButton = document.createElement('button')
  const detail = document.createElement('div')
  detail.innerHTML = renderDetailExtraFieldRows(customFields, null, {}, 'System')
  expect([...detail.querySelectorAll('.filament-spec-label')].map(label => label.textContent)).toEqual(['spoolman_extra.tag', 'spoolman_extra.note'])
  document.body.append(container, addButton)
  const editor = createEntityExtraFieldEditor({ container, addButton })
  editor.setData(customFields)
  expect([...container.querySelectorAll('tbody tr td:first-child')].map(cell => cell.textContent))
    .toEqual(['spoolman_extra.tag', 'spoolman_extra.note'])
  expect(editor.getPayload()?.customFields).toEqual(customFields)
  vi.stubGlobal('__fmConfirm', async () => true)
  container.querySelector<HTMLButtonElement>('.entity-extra-remove')!.click()
  await vi.waitFor(() => expect(container.querySelectorAll('tbody tr')).toHaveLength(1))
  expect(editor.getPayload()?.customFields).toEqual({
    spoolman_id: 8,
    spoolman_extra: { note: 'User note', filament_image_provider: 'bambulab', bambu_image_resolver_version: 2 },
  })
})


it('rejects a new field that would overwrite the legacy metadata container', async () => {
  const container = document.createElement('div'), addButton = document.createElement('button')
  document.body.append(container, addButton)
  const editor = createEntityExtraFieldEditor({ container, addButton })
  const customFields = { spoolman_extra: { bambu_profiles_by_model: { X1C: { base_name: 'PLA' } } } }
  editor.setData(customFields)
  addButton.click()
  document.querySelector<HTMLInputElement>('.extra-field-dialog-key')!.value = 'spoolman_extra'
  document.querySelector<HTMLInputElement>('.extra-field-dialog-label')!.value = 'Legacy data'
  const form = document.querySelector<HTMLFormElement>('.extra-field-dialog-form')!
  form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  await vi.waitFor(() => expect(document.querySelector<HTMLElement>('.extra-field-dialog-error')!.classList.contains('hidden')).toBe(false))
  expect(form.closest('dialog')!.open).toBe(true)
  expect(editor.getPayload()?.customFields).toEqual(customFields)
})
