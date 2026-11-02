// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { bootAstroPage } from '../../tests/helpers/astro-page'
import * as driver from './driver-config-form'
import * as state from './form-state'
import * as i18n from './i18n'
import * as abort from './abort'
import { copyText } from './clipboard'

const config = { url: 'http://printer.local', enabled: true, targets: [{ slot: 1 }] }
const writes: RequestInit[] = []
let persistedConfig = config
let resolveSave: ((response: Response) => void) | undefined
const printer = { id: 4, name: 'Workshop printer', driver_key: 'moonraker', is_active: true, driver_config: config, slots: [{ slot_no: 1, name: 'AMS slot 1', assignment: { present: true, spool_id: 8, spool_name: 'Blue PLA', material_type: 'PLA' } }] }

beforeEach(async () => {
  writes.length = 0
  persistedConfig = config
  vi.spyOn(window, 'addEventListener')
  vi.spyOn(document, 'addEventListener')
  resolveSave = undefined
  window.history.replaceState({}, '', '/printers/4')
  i18n.setLang('en')
  vi.stubGlobal('fetch', vi.fn(async (input, init?: RequestInit) => {
    const path = String(input)
    if (init?.method && init.method !== 'GET') {
      writes.push(init)
      return new Promise<Response>(resolve => { resolveSave = resolve })
    }
    if (path.endsWith('/admin/system/plugins')) return Response.json([{ driver_key: 'moonraker', config_schema: { properties: { url: { type: 'string', title: 'Printer URL', description: 'Connection address' }, enabled: { type: 'boolean' }, targets: { type: 'array' } } } }])
    if (path.includes('/driver/debug')) return Response.json([])
    if (path.endsWith('/driver/health')) return Response.json({ running: true, connected: true, printer_model: 'Model A', ams_units: [{ ams_id: 0, tray_count: 4, serial: 'AMS123', humidity: 35, temp: 25 }], sync_actions: [{ action: 'sync', label: 'Sync slots' }] })
    return Response.json({ ...printer, driver_config: persistedConfig })
  }))
  await bootAstroPage('printers/[id]', { ...driver, ...state, ...i18n, ...abort, copyText, initI18n: async () => {} })
  await vi.waitFor(() => expect(document.querySelector('#btn-edit-config')).not.toBeNull())
})
afterEach(() => {
  window.dispatchEvent(new Event('pagehide'))
  for (const [event, listener] of vi.mocked(window.addEventListener).mock.calls) window.removeEventListener(event, listener)
  for (const [event, listener] of vi.mocked(document.addEventListener).mock.calls) document.removeEventListener(event, listener)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  document.body.replaceChildren()
})

it('retains printer metadata, navigation and import actions', () => {
  expect(document.querySelector('h1')?.textContent).toBe('Workshop printer')
  expect(document.querySelector('.fm-admin-toolbar .fm-admin-back')?.getAttribute('href')).toBe('/printers')
  expect(document.querySelector('#printer-content')?.textContent).toContain('moonraker')
  expect(document.querySelector('#printer-content')?.textContent).toContain('AMS123')
  expect(document.querySelector('#printer-content')?.textContent).toContain('35%')
  expect(document.querySelector('a[href="/spools/8"]')?.textContent).toBe('Blue PLA')
  for (const selector of ['#btn-toggle-active', '#btn-delete', '#btn-export-params', '#import-params-file', '#btn-driver-toggle', '#btn-debug-console', '.btn-sync-action']) expect(document.querySelector(selector)).not.toBeNull()
  const input = document.querySelector<HTMLInputElement>('#import-params-file')!
  const chooseFile = vi.spyOn(input, 'click')
  document.querySelector<HTMLButtonElement>('#btn-import-params')!.click()
  expect(chooseFile).toHaveBeenCalledOnce()
  expect(writes).toHaveLength(0)
})

it('tracks config changes, freezes pending actions and retains failed drafts with structured values', async () => {
  document.querySelector<HTMLButtonElement>('#btn-edit-config')!.click()
  const form = document.querySelector<HTMLFormElement>('#config-form')!
  const save = form.querySelector<HTMLButtonElement>('[type="submit"]')!
  const url = form.querySelector<HTMLInputElement>('[name="url"]')!
  expect(save.disabled).toBe(true)
  expect(form.querySelector('[name="targets"]')).toBeNull()
  expect(form.querySelector('#config-targets')?.textContent).toContain('"slot": 1')
  const change = (value: string) => { url.value = value; url.dispatchEvent(new Event('input', { bubbles: true })) }
  change('http://changed.local')
  expect(save.disabled).toBe(false)
  change(config.url)
  expect(save.disabled).toBe(true)
  change('http://changed.local')
  form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  await vi.waitFor(() => expect(writes).toHaveLength(1))
  expect(form.inert).toBe(true)
  expect(document.getElementById('printer-content')!.inert).toBe(true)
  form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  expect(writes).toHaveLength(1)
  expect(document.querySelector<HTMLButtonElement>('#btn-edit-config')!.disabled).toBe(true)
  expect(JSON.parse(String(writes[0].body))).toEqual({ driver_config: { ...config, url: 'http://changed.local' } })
  resolveSave!(Response.json({}, { status: 400 }))
  await vi.waitFor(() => expect(form.inert).toBe(false))
  expect(url.value).toBe('http://changed.local')
  expect(save.disabled).toBe(false)
  expect(document.querySelector('#config-save-msg')?.classList.contains('hidden')).toBe(false)
  document.querySelector<HTMLButtonElement>('#btn-cancel-config')!.click()
  expect(document.querySelector('#config-form')).toBeNull()
  expect(document.activeElement?.id).toBe('btn-edit-config')
})

it('preserves the open config draft during printer refresh and establishes a fresh baseline after success', async () => {
  document.querySelector<HTMLButtonElement>('#btn-edit-config')!.click()
  const form = document.querySelector<HTMLFormElement>('#config-form')!
  const url = form.querySelector<HTMLInputElement>('[name="url"]')!
  url.value = 'http://updated.local'
  url.dispatchEvent(new Event('input', { bubbles: true }))
  window.dispatchEvent(new CustomEvent('filaman:data-changed', { detail: { event: 'printer_update', printer_id: 4 } }))
  await vi.waitFor(() => expect(vi.mocked(fetch).mock.calls.filter(([path]) => String(path).endsWith('/driver/health'))).toHaveLength(2))
  expect(document.querySelector('#config-form')).toBe(form)
  expect(url.value).toBe('http://updated.local')
  expect(form.dataset.dirty).toBe('true')
  form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  await vi.waitFor(() => expect(writes).toHaveLength(1))
  persistedConfig = { ...config, url: url.value }
  resolveSave!(Response.json({}))
  await vi.waitFor(() => expect(document.querySelector('#config-form')).toBeNull())
  expect(document.querySelector('#config-content')?.textContent).toContain('http://updated.local')
  document.querySelector<HTMLButtonElement>('#btn-edit-config')!.click()
  expect(document.querySelector<HTMLButtonElement>('#config-form [type="submit"]')!.disabled).toBe(true)
  expect(document.getElementById('printer-content')!.inert).toBe(false)
})

it('keeps debug log controls connected to their enable and disable commands', async () => {
  document.querySelector<HTMLButtonElement>('#btn-debug-console')!.click()
  await vi.waitFor(() => expect(writes).toHaveLength(1))
  expect(JSON.parse(String(writes[0].body))).toEqual({ action: 'enable_debug_log', params: {} })
  resolveSave!(Response.json({}))
  await vi.waitFor(() => expect(document.querySelector('#debug-log-container')).not.toBeNull())
  expect(document.getElementById('btn-clear-debug')).not.toBeNull()
  document.querySelector<HTMLButtonElement>('#btn-close-debug')!.click()
  await vi.waitFor(() => expect(writes).toHaveLength(2))
  expect(JSON.parse(String(writes[1].body))).toEqual({ action: 'disable_debug_log', params: {} })
  resolveSave!(Response.json({}))
  await vi.waitFor(() => expect(document.querySelector('#debug-log-container')).toBeNull())
})
