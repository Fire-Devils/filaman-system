// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { experimental_AstroContainer as AstroContainer } from 'astro/container'
import { createSourceFile, isImportDeclaration, ScriptTarget, transpileModule } from 'typescript'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import SpoolForm from '../components/SpoolForm.astro'
import * as extra from './extra-fields'
import * as entity from './entity-extra-fields'
import * as cache from './cache'
import * as locations from './driver-managed-locations'
import * as abort from './abort'
import * as colors from './colors'
import * as format from './format'
import * as i18n from './i18n'

const filament = { id: 3, designation: 'Fixture PLA', material_type: 'PLA', raw_material_weight_g: 1000, default_spool_weight_g: 200, spool_material: 'Cardboard', price: 19, manufacturer: { name: 'Maker' }, colors: [] }
const otherFilament = { ...filament, id: 4, designation: 'Fixture PETG', material_type: 'PETG', raw_material_weight_g: 750, default_spool_weight_g: 100, price: 29 }
const writes: Array<{ url: string; body: Record<string, unknown> }> = []
const page = readFileSync('src/pages/spools/new.astro', 'utf8')
const source = page.match(/<script>([\s\S]*?)<\/script>/)![1]
const parsed = createSourceFile('create.ts', source, ScriptTarget.Latest, true)
const script = parsed.statements.filter(node => !isImportDeclaration(node)).map(node => node.getText(parsed)).join('\n')
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor

beforeEach(() => {
  writes.length = 0
  sessionStorage.clear()
  history.replaceState(null, '', '/spools/new?from_tag=1')
  i18n.setLang('en')
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      writes.push({ url, body: JSON.parse(String(init.body)) })
      if (url.endsWith('/resolve-from-tag')) return Response.json({ filament_id: 3 })
      return Response.json({ detail: { message: 'Try again' } }, { status: 503 })
    }
    return Response.json(url.includes('/system-extra-fields?') ? [{ key: 'system_note', label: 'System note', field_type: 'text' }] : [])
  }))
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren() })

async function boot() {
  const container = await AstroContainer.create()
  document.body.innerHTML = page.match(/<Layout[^>]*>([\s\S]*?)<script>/)![1].replace('<SpoolForm />', await container.renderToString(SpoolForm))
  const dependencies = {
    ...extra, ...entity, ...cache, ...locations, ...abort, ...colors, ...format, ...i18n,
    initI18n: async () => {}, initCurrency: async () => 'EUR',
    cachedFetchAllPages: async (_key: string, url: string) => ({ items: url.includes('/filaments') ? [filament, otherFilament] : [{ id: 4, name: 'Shelf' }, { id: 5, name: 'AMS', custom_fields: { managed_by: 'driver_plugin' } }] }),
  }
  const runtime = await new AsyncFunction(...Object.keys(dependencies), transpileModule(script.replace('    checkActiveDevicesForImport()', '    checkActiveDevicesForImport(); return { applyTagDataToForm, selectFilament, entityExtraFields }'), { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText)(...Object.values(dependencies))
  return runtime
}

it('opens the existing filament list when Add Spool has no filament or duplicate', async () => {
  history.replaceState(null, '', '/spools/new')
  const redirect = vi.spyOn(window.location, 'replace').mockImplementation(() => {})
  await boot()
  expect(redirect).toHaveBeenCalledWith('/filaments?select_for_spool=1')
  expect(fetch).not.toHaveBeenCalled()
})

it('does not enable creation for a filament that no longer exists', async () => {
  history.replaceState(null, '', '/spools/new?filament_id=999')
  await boot()
  expect(document.querySelector<HTMLFieldSetElement>('#spool-create-details')!.hidden).toBe(true)
  expect(document.querySelector<HTMLButtonElement>('#submit-btn')!.disabled).toBe(true)
  document.getElementById('spool-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  expect(writes).toHaveLength(0)
})

it('preserves an empty-spool template through filament selection and consumes it only after a valid selection', async () => {
  const template = JSON.stringify({ empty_spool_weight_g: 170, spool_material: 'Plastic', spool_outer_diameter_mm: 201, spool_width_mm: 68, rfid_uid: 'AABBCCDD', rfid_uid_2: 'EEFF0011' })
  sessionStorage.setItem('filaman_duplicate_spool', template)
  history.replaceState(null, '', '/spools/new')
  const redirect = vi.spyOn(window.location, 'replace').mockImplementation(() => {})
  await boot()
  expect(redirect).toHaveBeenCalledWith('/filaments?select_for_spool=1')
  expect(sessionStorage.getItem('filaman_duplicate_spool')).toBe(template)
  expect(fetch).not.toHaveBeenCalled()

  history.replaceState(null, '', '/spools/new?filament_id=999')
  await boot()
  expect(sessionStorage.getItem('filaman_duplicate_spool')).toBe(template)

  history.replaceState(null, '', '/spools/new?filament_id=3')
  await boot()
  expect(document.querySelector<HTMLFieldSetElement>('#spool-create-details')!.hidden).toBe(false)
  for (const [id, value] of Object.entries(JSON.parse(template))) {
    expect(document.querySelector<HTMLInputElement>(`#${id}`)!.value).toBe(String(value))
  }
  expect(sessionStorage.getItem('filaman_duplicate_spool')).toBeNull()
})

it('requires an existing filament before exposing the shared spool fields and retains failed creation drafts', async () => {
  const runtime = await boot()
  const details = document.querySelector<HTMLFieldSetElement>('#spool-create-details')!
  expect(details?.hidden).toBe(true)
  expect(details.disabled).toBe(true)
  expect(document.querySelector<HTMLButtonElement>('#submit-btn')!.disabled).toBe(true)
  runtime.selectFilament(3)
  expect(details.hidden).toBe(false)
  expect(details.disabled).toBe(false)
  expect(document.querySelector<HTMLInputElement>('#initial_total_weight_g')!.value).toBe('1200')
  expect(document.querySelectorAll('#location_id option')).toHaveLength(2)
  ;(document.getElementById('spool_quantity') as HTMLInputElement).value = '2'
  ;(document.getElementById('lot_number') as HTMLInputElement).value = 'Draft lot'
  document.getElementById('spool-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  await vi.waitFor(() => expect(document.getElementById('error-message')!.textContent).toBe('Try again'))
  expect(writes[0]).toMatchObject({ url: '/api/v1/spools/bulk', body: { filament_id: 3, quantity: 2, initial_total_weight_g: 1200, empty_spool_weight_g: 200, remaining_weight_g: 1000, lot_number: 'Draft lot' } })
  expect(document.querySelector<HTMLInputElement>('#lot_number')!.value).toBe('Draft lot')
  expect(document.querySelector<HTMLButtonElement>('#submit-btn')!.disabled).toBe(false)
})

it('opens preselected and duplicated spools without copying a driver-managed location', async () => {
  history.replaceState(null, '', '/spools/new?filament_id=3')
  sessionStorage.setItem('filaman_duplicate_spool', JSON.stringify({ filament_id: 3, initial_total_weight_g: 1300, spool_core_weight_g: 0, lot_number: 'Duplicate', location_id: 5, rfid_uid: 'AABBCCDD' }))
  await boot()
  expect(document.querySelector<HTMLFieldSetElement>('#spool-create-details')!.hidden).toBe(false)
  expect(document.querySelector<HTMLInputElement>('#initial_total_weight_g')!.value).toBe('1300')
  expect(document.querySelector<HTMLInputElement>('#lot_number')!.value).toBe('Duplicate')
  expect(document.querySelector<HTMLInputElement>('#rfid_uid')!.value).toBe('AABBCCDD')
  expect(document.querySelector<HTMLSelectElement>('#location_id')!.value).toBe('')
  expect(document.querySelector<HTMLInputElement>('#uses_spool_core')!.checked).toBe(false)
})

it('opens the spool fields after resolving a filament from a tag', async () => {
  const runtime = await boot()
  await runtime.applyTagDataToForm({ type: 'PLA', brand: 'Maker', weight: 900 })
  expect(document.querySelector<HTMLFieldSetElement>('#spool-create-details')!.hidden).toBe(false)
  expect(document.querySelector<HTMLInputElement>('#filament_id')!.value).toBe('3')
})

it('applies an empty-spool template once a tag resolves its filament', async () => {
  sessionStorage.setItem('filaman_duplicate_spool', JSON.stringify({ empty_spool_weight_g: 170, rfid_uid: 'AABBCCDD' }))
  const runtime = await boot()
  expect(sessionStorage.getItem('filaman_duplicate_spool')).not.toBeNull()
  await runtime.applyTagDataToForm({ type: 'PLA', brand: 'Maker' })
  expect(document.querySelector<HTMLInputElement>('#empty_spool_weight_g')!.value).toBe('170')
  expect(document.querySelector<HTMLInputElement>('#rfid_uid')!.value).toBe('AABBCCDD')
  expect(sessionStorage.getItem('filaman_duplicate_spool')).toBeNull()
})

it.each(['/filaments?select_for_spool=1', '/filaments/new?create_spool=1'])('retains the spool draft through %s and reapplies the selected filament defaults', async href => {
  history.replaceState(null, '', '/spools/new?filament_id=3')
  const runtime = await boot()
  const values = { lot_number: 'Draft lot', external_id: 'external-7', rfid_uid: 'AABBCCDD', spool_quantity: '3', location_id: '4', purchase_date: '2025-05-06', low_weight_threshold_g: '75', spool_core_weight_g: '7' }
  for (const [id, value] of Object.entries(values)) (document.getElementById(id) as HTMLInputElement).value = value
  ;(document.getElementById('uses_spool_core') as HTMLInputElement).checked = true
  ;(document.getElementById('initial_total_weight_g') as HTMLInputElement).value = '9999'
  ;(document.getElementById('purchase_price') as HTMLInputElement).value = '999'
  ;(document.querySelector('[data-key="system_note"]') as HTMLInputElement).value = 'System draft'
  runtime.entityExtraFields.setData({ drying: { temperature: 55 } }, { 'drying.temperature': { label: 'Drying temperature', field_type: 'number', config: { unit: '°C' } } })
  const link = document.querySelector<HTMLAnchorElement>(`#spool-form a[href="${href}"]`)!
  link.addEventListener('click', event => event.preventDefault())
  link.click()
  expect(sessionStorage.getItem('filaman_spool_create_draft')).not.toBeNull()

  history.replaceState(null, '', '/spools/new?filament_id=999')
  await boot()
  expect(sessionStorage.getItem('filaman_spool_create_draft')).not.toBeNull()

  history.replaceState(null, '', '/spools/new?filament_id=4')
  const restored = await boot()
  for (const [id, value] of Object.entries(values)) expect((document.getElementById(id) as HTMLInputElement).value).toBe(value)
  expect(document.querySelector<HTMLInputElement>('#filament_id')!.value).toBe('4')
  expect(document.querySelector<HTMLInputElement>('#initial_total_weight_g')!.value).toBe('850')
  expect(document.querySelector<HTMLInputElement>('#empty_spool_weight_g')!.value).toBe('100')
  expect(document.querySelector<HTMLInputElement>('#purchase_price')!.value).toBe('29')
  expect(document.querySelector<HTMLInputElement>('#uses_spool_core')!.checked).toBe(true)
  expect((document.querySelector('[data-key="system_note"]') as HTMLInputElement).value).toBe('System draft')
  expect(restored.entityExtraFields.getPayload()).toMatchObject({ customFields: { drying: { temperature: 55 } }, customFieldDefinitions: { 'drying.temperature': { field_type: 'number' } } })
  expect(sessionStorage.getItem('filaman_spool_create_draft')).toBeNull()
})

it('does not let tag callbacks enable a second create while the first request is pending', async () => {
  const originalFetch = fetch
  let finishCreate!: (response: Response) => void
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    if (url === '/api/v1/spools/bulk') {
      writes.push({ url, body: JSON.parse(String(init?.body)) })
      return new Promise<Response>(resolve => { finishCreate = resolve })
    }
    return originalFetch(url, init)
  }))
  const runtime = await boot()
  runtime.selectFilament(3)
  const form = document.getElementById('spool-form')!
  form.dispatchEvent(new Event('submit', { cancelable: true }))
  expect(writes.filter(write => write.url === '/api/v1/spools/bulk')).toHaveLength(1)
  await runtime.applyTagDataToForm({ type: 'PLA', brand: 'Maker' })
  expect(document.querySelector<HTMLButtonElement>('#submit-btn')!.disabled).toBe(true)
  form.dispatchEvent(new Event('submit', { cancelable: true }))
  expect(writes.filter(write => write.url === '/api/v1/spools/bulk')).toHaveLength(1)
  finishCreate(Response.json({ detail: { message: 'Try again' } }, { status: 503 }))
  await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>('#submit-btn')!.disabled).toBe(false))
})

it('retains manual filament-related values when the same filament is selected again', async () => {
  history.replaceState(null, '', '/spools/new?filament_id=3')
  await boot()
  const manualValues = { initial_total_weight_g: '950', empty_spool_weight_g: '175', purchase_price: '12.50', spool_material: 'Plastic', spool_outer_diameter_mm: '198', spool_width_mm: '62' }
  for (const [id, value] of Object.entries(manualValues)) (document.getElementById(id) as HTMLInputElement).value = value
  const link = document.querySelector<HTMLAnchorElement>('#spool-form a[href="/filaments?select_for_spool=1"]')!
  link.addEventListener('click', event => event.preventDefault())
  link.click()
  await boot()
  for (const [id, value] of Object.entries(manualValues)) expect((document.getElementById(id) as HTMLInputElement).value).toBe(value)
  expect(sessionStorage.getItem('filaman_spool_create_draft')).toBeNull()
})

it('submits manual container values without changing the filament defaults', async () => {
  history.replaceState(null, '', '/spools/new?filament_id=3')
  await boot()
  for (const [id, value] of Object.entries({ spool_material: 'Metal', empty_spool_weight_g: '175', spool_outer_diameter_mm: '198', spool_width_mm: '62' })) {
    (document.getElementById(id) as HTMLInputElement | HTMLSelectElement).value = value
  }
  document.getElementById('spool-form')!.dispatchEvent(new Event('submit', { cancelable: true }))
  await vi.waitFor(() => expect(writes).toHaveLength(1))
  expect(writes[0]).toMatchObject({ url: '/api/v1/spools/bulk', body: {
    filament_id: 3, spool_material: 'Metal', empty_spool_weight_g: 175, spool_outer_diameter_mm: 198, spool_width_mm: 62,
  } })
  expect(filament).toMatchObject({ material_type: 'PLA', spool_material: 'Cardboard', default_spool_weight_g: 200 })
})

it.each(['.detail-back-link', '[data-i18n="common.cancel"]'])('clears an abandoned ordinary draft through %s while preserving its empty-spool template', async selector => {
  sessionStorage.setItem('filaman_spool_create_draft', '{"fields":{"spool_quantity":"3"}}')
  sessionStorage.setItem('filaman_duplicate_spool', '{"rfid_uid":"AABBCCDD"}')
  history.replaceState(null, '', '/spools/new?filament_id=999')
  await boot()
  document.querySelector(selector)!.dispatchEvent(new Event('click'))
  expect(sessionStorage.getItem('filaman_spool_create_draft')).toBeNull()
  expect(sessionStorage.getItem('filaman_duplicate_spool')).toBe('{"rfid_uid":"AABBCCDD"}')
})

it('retains invalid extra-field drafts on the current page when navigation cannot capture them', async () => {
  history.replaceState(null, '', '/spools/new?filament_id=3')
  await boot()
  document.getElementById('system-fields-grid')!.insertAdjacentHTML('beforeend', extra.renderFieldInput({ key: 'drying_range', label: 'Drying range', field_type: 'range' }, { min: 20, max: 10 }))
  const link = document.querySelector<HTMLAnchorElement>('#spool-form a[href="/filaments?select_for_spool=1"]')!
  const event = new MouseEvent('click', { bubbles: true, cancelable: true })
  expect(link.dispatchEvent(event)).toBe(false)
  expect(event.defaultPrevented).toBe(true)
  expect(sessionStorage.getItem('filaman_spool_create_draft')).toBeNull()
  expect(document.querySelector<HTMLInputElement>('[data-range-end="min"]')!.value).toBe('20')
  expect(document.querySelector<HTMLInputElement>('[data-range-end="max"]')!.value).toBe('10')
  expect(document.querySelector<HTMLInputElement>('[data-range-end="max"]')!.validity.customError).toBe(true)
})

it('uses the existing French error label when saving a spool draft throws a non-Error value', async () => {
  history.replaceState(null, '', '/spools/new?filament_id=3')
  await boot()
  i18n.setLang('fr')
  vi.spyOn(sessionStorage, 'setItem').mockImplementation(() => { throw null })
  const link = document.querySelector<HTMLAnchorElement>('#spool-form a[href="/filaments?select_for_spool=1"]')!
  expect(link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))).toBe(false)
  expect(document.getElementById('error-message')!.textContent).toBe('Erreur')
})
