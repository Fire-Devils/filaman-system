// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { createSourceFile, isImportDeclaration, ScriptTarget, transpileModule } from 'typescript'
import { experimental_AstroContainer as AstroContainer } from 'astro/container'
import FormDialog from '../components/FormDialog.astro'
import FormSection from '../components/FormSection.astro'
import ColorEditorFields from '../components/ColorEditorFields.astro'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as dialog from './form-dialog'
import * as state from './form-state'
import * as driver from './driver-config-form'
import * as i18n from './i18n'
import * as abort from './abort'
import * as scanner from './tag-scanner'
import * as escape from './extra-fields'
import * as actions from './table-actions'
import * as colors from './colors'
import * as filters from './table-column-filters'

const calls: { path: string; init?: RequestInit }[] = []
let failSave = false
let intercept: ((path: string, init?: RequestInit) => Response | Promise<Response> | undefined) | undefined
const settings = { login_disabled: false, currency: 'EUR', rfid_protocol: 'openspool', rfid_extended_data_enabled: false, rfid_display_colons: true, default_spool_core_weight_g: 0, bambu_unmatched_profile_fallback: 'generic', filament_lookup_source: 'filamandb' }
const printer = { id: 4, name: 'Example printer', driver_key: 'moonraker', driver_config: { url: 'http://printer.local', enabled: true, targets: [{ slot: 1 }] } }
const dependencies = {
  ...dialog, ...state, ...driver, ...i18n, ...abort, ...scanner, ...escape, ...actions, ...colors, ...filters,
  fetchAllPages: async () => ({ items: [{ id: 2, name: 'Translucent blue', hex_code: '#12345680', usage_count: 1 }] }),
  initI18n: async () => {}, initCurrency: async () => {}, initColumnPicker: () => {}, initColumnResize: () => {},
  invalidateCachePrefix: () => {}, CACHE_KEYS: { LOCATIONS: 'locations' },
  cachedFetchAllPages: async () => ({ items: [{ id: 3, name: 'Shelf "A" <blue>', identifier: 'UID', spool_count: 1 }] }),
}
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
async function boot(path: string) {
  const container = await AstroContainer.create()
  const page = readFileSync(`src/pages/${path}.astro`, 'utf8')
  let html = page.match(/<Layout[^>]*>([\s\S]*?)<script>/)![1]
  for (const match of [...html.matchAll(/<FormDialog([^>]*)>([\s\S]*?)<\/FormDialog>/g)]) {
    const props = Object.fromEntries([...match[1].matchAll(/(\w+)="([^"]*)"/g)].map(attr => [attr[1], attr[2]]))
    const actions = match[2].match(/<Fragment slot="actions">([\s\S]*?)<\/Fragment>/)![1]
    const body = match[2].replace(/<Fragment slot="actions">[\s\S]*?<\/Fragment>/, '')
    html = html.replace(match[0], await container.renderToString(FormDialog, { props, slots: { actions, default: body } }))
  }
  for (const match of [...html.matchAll(/<FormSection([^>]*)>([\s\S]*?)<\/FormSection>/g)]) {
    const props = Object.fromEntries([...match[1].matchAll(/(\w+)="([^"]*)"/g)].map(attr => [attr[1], attr[2]]))
    const actions = match[2].match(/<Fragment slot="actions">([\s\S]*?)<\/Fragment>/)?.[1] || ''
    const body = match[2].replace(/<Fragment slot="actions">[\s\S]*?<\/Fragment>/, '')
    html = html.replace(match[0], await container.renderToString(FormSection, { props, slots: { actions, default: body } }))
  }
  if (html.includes('<ColorEditorFields')) html = html.replace('<ColorEditorFields idPrefix="color" />', await container.renderToString(ColorEditorFields, { props: { idPrefix: 'color' } }))
  document.body.innerHTML = html
  const source = page.match(/<script>([\s\S]*?)<\/script>/)![1]
  const parsed = createSourceFile('page.ts', source, ScriptTarget.Latest, true)
  const production = parsed.statements.filter(node => !isImportDeclaration(node)).map(node => node.getText(parsed)).join('\n')
  await new AsyncFunction(...Object.keys(dependencies), transpileModule(production, { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText)(...Object.values(dependencies))
}
function change(id: string, value: string | boolean) {
  const input = document.getElementById(id) as HTMLInputElement
  if (typeof value === 'boolean') input.checked = value
  else input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.dispatchEvent(new Event('change', { bubbles: true }))
}
function submit(id: string) { document.getElementById(id)!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) }
function writes() { return calls.filter(call => call.init?.method && call.init.method !== 'GET') }
beforeEach(() => {
  calls.length = 0
  failSave = false
  intercept = undefined
  localStorage.clear()
  localStorage.setItem('lang', 'en')
  i18n.setLang('en')
  vi.stubGlobal('fetch', vi.fn(async (input, init?: RequestInit) => {
    const path = String(input)
    calls.push({ path, init })
    const overridden = intercept?.(path, init)
    if (overridden) return overridden
    if (init?.method) return failSave ? Response.json({ message: 'Save failed' }, { status: 400 }) : Response.json({ success: true })
    if (path === '/api/v1/me') return Response.json({ email: 'test@example.com', display_name: 'Test', language: 'en' })
    if (path.includes('app-settings')) return Response.json(settings)
    if (path.includes('/admin/system/plugins')) return Response.json([{ driver_key: 'moonraker', plugin_type: 'printer_driver', is_active: true, config_schema: { properties: { url: { type: 'string' }, enabled: { type: 'boolean' }, targets: { type: 'array' } } } }])
    if (path === '/api/v1/printers') return Response.json({ items: [printer] })
    if (path === '/api/v1/printers/4') return Response.json(printer)
    return Response.json([])
  }))
})
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren() })

it('retains structured driver config when editing through the printer dialog', async () => {
  await boot('printers/index')
  await vi.waitFor(() => expect(document.querySelector('.btn-edit')).not.toBeNull())
  document.querySelector<HTMLButtonElement>('.btn-edit')!.click()
  await vi.waitFor(() => expect(document.querySelector<HTMLDialogElement>('#modal-container')!.open).toBe(true))
  expect(document.querySelector<HTMLButtonElement>('#modal-submit')!.disabled).toBe(true)
  change('printer-name', 'Updated printer')
  submit('modal-form')
  await vi.waitFor(() => expect(writes()).toHaveLength(1))
  expect(JSON.parse(String(writes()[0].init!.body))).toEqual({ name: 'Updated printer', driver_key: 'moonraker', driver_config: printer.driver_config })
  await vi.waitFor(() => expect(document.querySelector<HTMLDialogElement>('#modal-container')!.open).toBe(false))
})
it.each([['en', 'Edit'], ['de', 'Bearbeiten']] as const)('retains quoted location names and translated actions (%s)', async (lang, label) => {
  i18n.setLang(lang)
  await boot('locations/index')
  await vi.waitFor(() => expect(document.querySelector('.btn-edit')).not.toBeNull())
  expect(document.querySelector('.btn-edit')!.getAttribute('aria-label')).toBe(label)
  document.querySelector<HTMLButtonElement>('.btn-edit')!.click()
  expect(document.querySelector<HTMLInputElement>('#location-name')!.value).toBe('Shelf "A" <blue>')
  expect(document.querySelector<HTMLDialogElement>('#modal-container')!.open).toBe(true)
  expect(document.querySelector<HTMLDialogElement>('#rfid-modal')!.open).toBe(false)
  change('location-name', 'Shelf B')
  submit('modal-form')
  await vi.waitFor(() => expect(writes()).toHaveLength(1))
  expect(JSON.parse(String(writes()[0].init!.body))).toEqual({ name: 'Shelf B', identifier: 'UID' })
})

it('preserves alpha colors and keeps in-use Delete unavailable', async () => {
  await boot('filaments/colors')
  await vi.waitFor(() => expect(document.querySelector('.btn-edit')).not.toBeNull())
  expect(document.querySelector<HTMLButtonElement>('.btn-delete')!.disabled).toBe(true)
  document.querySelector<HTMLButtonElement>('.btn-edit')!.click()
  expect(document.querySelector<HTMLInputElement>('#color-hex')!.value).toBe('#12345680')
  expect(document.querySelector<HTMLButtonElement>('#modal-submit')!.disabled).toBe(true)
  change('color-name', 'Renamed translucent blue')
  submit('modal-form')
  await vi.waitFor(() => expect(writes()).toHaveLength(1))
  expect(JSON.parse(String(writes()[0].init!.body))).toEqual({ name: 'Renamed translucent blue', hex_code: '#12345680' })
})

it('ignores a late RFID write response after Escape and reopening the dialog', async () => {
  let resolveWrite!: (response: Response) => void
  const pendingWrite = new Promise<Response>(resolve => { resolveWrite = resolve })
  intercept = (path, init) => {
    if (path === '/api/v1/devices/active') return Response.json([{ id: 9, name: 'Test device' }])
    if (init?.method === 'POST' && path.includes('write-tag')) return pendingWrite
  }
  await boot('locations/index')
  await vi.waitFor(() => expect(document.querySelector('.btn-edit')).not.toBeNull())
  const openRfid = (window as unknown as { openRfidModal: (id: number) => void }).openRfidModal
  openRfid(3)
  vi.useFakeTimers()
  document.querySelector<HTMLButtonElement>('#rfid-confirm')!.click()
  const rfid = document.querySelector<HTMLDialogElement>('#rfid-modal')!
  rfid.dispatchEvent(new Event('cancel', { cancelable: true }))
  resolveWrite(Response.json({ success: true }))
  await vi.advanceTimersByTimeAsync(5000)
  expect(calls.some(call => call.path.includes('write-status'))).toBe(false)
  openRfid(3)
  expect(rfid.open).toBe(true)
  expect(document.querySelector<HTMLButtonElement>('#rfid-confirm')!.disabled).toBe(false)
  expect(document.querySelector('#rfid-status')!.classList.contains('hidden')).toBe(true)
  document.querySelector<HTMLButtonElement>('#rfid-cancel')!.click()
})
