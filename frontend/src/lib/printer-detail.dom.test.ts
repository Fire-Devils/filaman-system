// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { bootAstroPage } from '../../tests/helpers/astro-page'
import * as driver from './driver-config-form'
import * as state from './form-state'
import * as i18n from './i18n'
import * as abort from './abort'
import { copyText } from './clipboard'
import { toOpaqueRgbHex } from './colors'
import { escapeHtml } from './extra-fields'

const config = { url: 'http://printer.local', enabled: true, targets: [{ slot: 1 }] }
const writes: RequestInit[] = []
let persistedConfig = config
let resolveSave: ((response: Response) => void) | undefined
const health = { running: true, connected: true, printer_model: 'Model A', ams_units: [{ ams_id: 0, tray_count: 4, serial: 'AMS123', humidity: 35, temp: 25 }], sync_actions: [{ action: 'sync', label: 'Sync slots' }] }
let healthResponse: Record<string, unknown>
const printer = {
  id: 4, name: 'Workshop printer', driver_key: 'moonraker', is_active: true, driver_config: config,
  slots: [
    { slot_no: 1, name: 'AMS slot 1', assignment: { present: true, spool_id: 8, spool_name: 'Blue PLA', material_type: 'PLA', tray_color: '123456"; data-injected="yes' } },
    { slot_no: 4, name: 'Removed AMS bay', is_active: false, assignment: { present: false } },
  ],
}

beforeEach(async () => {
  writes.length = 0
  persistedConfig = config
  healthResponse = health
  vi.spyOn(window, 'setInterval')
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
    if (path.endsWith('/driver/health')) return Response.json(healthResponse)
    return Response.json({ ...printer, driver_config: persistedConfig })
  }))
  await bootAstroPage('printers/[id]', { ...driver, ...state, ...i18n, ...abort, copyText, toOpaqueRgbHex, escapeHtml, initI18n: async () => {} })
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
  expect(document.querySelector('#printer-content')?.textContent).not.toContain('Removed AMS bay')
  expect(document.querySelector('[data-injected]')).toBeNull()
  for (const selector of ['#btn-toggle-active', '#btn-delete', '#btn-export-params', '#import-params-file', '#btn-driver-toggle', '#btn-debug-console', '.btn-sync-action']) expect(document.querySelector(selector)).not.toBeNull()
  const input = document.querySelector<HTMLInputElement>('#import-params-file')!
  const chooseFile = vi.spyOn(input, 'click')
  document.querySelector<HTMLButtonElement>('#btn-import-params')!.click()
  expect(chooseFile).toHaveBeenCalledOnce()
  expect(writes).toHaveLength(0)
})

it('renders live driver telemetry and action keys as text', async () => {
  const serial = '<img id="serial-injection" src=x>'
  const humidity = '<img id="humidity-injection" src=x>'
  const temperature = '<img id="temperature-injection" src=x>'
  const action = 'sync" data-action-injection="yes'
  healthResponse = {
    ...health,
    ams_type: '<img id="ams-type-injection" src=x>',
    ams_units: [{ ams_id: 0, tray_count: 4, serial, humidity, temp: temperature }],
    sync_actions: [{ action, label: 'Sync slots' }],
  }
  window.dispatchEvent(new CustomEvent('filaman:data-changed', { detail: { event: 'printer_update', printer_id: 4 } }))
  await vi.waitFor(() => expect(document.querySelector('#printer-content')?.textContent).toContain(serial))
  expect(document.querySelector('#printer-content')?.textContent).toContain(humidity)
  expect(document.querySelector('#printer-content')?.textContent).toContain(temperature)
  expect(document.querySelector('#serial-injection, #humidity-injection, #temperature-injection, #ams-type-injection, [data-action-injection]')).toBeNull()
  expect(document.querySelector<HTMLElement>('.btn-sync-action')?.dataset.action).toBe(action)
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

it.each([200, 404, 500, 'network'])('resync preserves an editor opened while refresh is pending (%s)', async status => {
  const fetchPrinter = vi.mocked(fetch).getMockImplementation()!
  let release: (response: Response) => void = () => {}
  let reject: (reason: Error) => void = () => {}
  const pending = new Promise<Response>((resolve, fail) => { release = resolve; reject = fail })
  vi.mocked(fetch).mockImplementation((input, init) => String(input) === '/api/v1/printers/4' ? pending : fetchPrinter(input, init))
  const before = vi.mocked(fetch).mock.calls.length
  window.dispatchEvent(new CustomEvent('filaman:data-changed', { detail: { event: 'resync' } }))
  await vi.waitFor(() => expect(vi.mocked(fetch).mock.calls.length).toBeGreaterThan(before))
  document.querySelector<HTMLButtonElement>('#btn-edit-config')!.click()
  const form = document.querySelector<HTMLFormElement>('#config-form')!
  const url = form.querySelector<HTMLInputElement>('[name="url"]')!
  url.value = 'http://unsaved.local'
  url.dispatchEvent(new Event('input', { bubbles: true }))
  if (status === 'network') reject(new Error('Offline'))
  else release(Response.json(printer, { status: Number(status) }))
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(document.querySelector('#config-form')).toBe(form)
  expect(url.value).toBe('http://unsaved.local')
  expect(form.dataset.dirty).toBe('true')
  expect(writes).toHaveLength(0)
})

it.each([200, 404, 'network'])('ignores an older resync response after a successful save (%s)', async status => {
  const fetchPrinter = vi.mocked(fetch).getMockImplementation()!
  let held = false
  let release: (response: Response) => void = () => {}
  let reject: (reason: Error) => void = () => {}
  const pending = new Promise<Response>((resolve, fail) => { release = resolve; reject = fail })
  vi.mocked(fetch).mockImplementation((input, init) => {
    if (String(input) === '/api/v1/printers/4' && !init?.method && !held) {
      held = true
      return pending
    }
    return fetchPrinter(input, init)
  })
  window.dispatchEvent(new CustomEvent('filaman:data-changed', { detail: { event: 'resync' } }))
  await vi.waitFor(() => expect(held).toBe(true))
  document.querySelector<HTMLButtonElement>('#btn-edit-config')!.click()
  const form = document.querySelector<HTMLFormElement>('#config-form')!
  const url = form.querySelector<HTMLInputElement>('[name="url"]')!
  url.value = 'http://saved.local'
  url.dispatchEvent(new Event('input', { bubbles: true }))
  form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  await vi.waitFor(() => expect(writes).toHaveLength(1))
  persistedConfig = { ...config, url: url.value }
  resolveSave!(Response.json({}))
  await vi.waitFor(() => expect(document.querySelector('#config-form')).toBeNull())
  expect(document.querySelector('#config-content')?.textContent).toContain('http://saved.local')
  if (status === 'network') reject(new Error('Offline'))
  else release(Response.json(printer, { status: Number(status) }))
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(document.querySelector('#config-content')?.textContent).toContain('http://saved.local')
  document.querySelector<HTMLButtonElement>('#btn-edit-config')!.click()
  expect(document.querySelector<HTMLInputElement>('#config-form [name="url"]')?.value).toBe('http://saved.local')
})

it.each(['schema', 'health', 'health-error'])('ignores obsolete %s state before binding visible actions', async resource => {
  const fetchPrinter = vi.mocked(fetch).getMockImplementation()!
  const target = resource === 'schema' ? '/admin/system/plugins' : '/driver/health'
  let held = false
  let release: (response: Response) => void = () => {}
  let reject: (reason: Error) => void = () => {}
  const pending = new Promise<Response>((resolve, fail) => { release = resolve; reject = fail })
  vi.mocked(fetch).mockImplementation((input, init) => {
    if (String(input).endsWith(target) && !held) { held = true; return pending }
    return fetchPrinter(input, init)
  })
  window.dispatchEvent(new CustomEvent('filaman:data-changed', { detail: { event: 'resync' } }))
  await vi.waitFor(() => expect(held).toBe(true))
  window.dispatchEvent(new CustomEvent('filaman:data-changed', { detail: { event: 'resync' } }))
  await vi.waitFor(() => expect(vi.mocked(fetch).mock.calls.filter(([path]) => String(path).endsWith('/driver/health'))).toHaveLength(resource === 'schema' ? 2 : 3))
  await new Promise(resolve => setTimeout(resolve, 0))
  if (resource === 'health') release(Response.json({ ...health, running: false }))
  else reject(new Error('Obsolete read failed'))
  await new Promise(resolve => setTimeout(resolve, 0))
  if (resource === 'schema') {
    document.querySelector<HTMLButtonElement>('#btn-edit-config')!.click()
    expect(document.querySelector('#config-form [name="url"]')).not.toBeNull()
  } else {
    const toggle = document.querySelector<HTMLButtonElement>('#btn-driver-toggle')!
    toggle.click()
    await vi.waitFor(() => expect(writes).toHaveLength(1))
    expect(String(vi.mocked(fetch).mock.calls.find(([, init]) => init?.method === 'POST')?.[0])).toMatch(/driver\/stop$/)
    resolveSave!(Response.json({}))
    // A successful toggle waits one second before refreshing and replacing the controls.
    await vi.waitFor(() => expect(toggle.isConnected).toBe(false), { timeout: 3000 })
  }
})

it('applies completed health polls while a newer poll is still pending', async () => {
  const poll = vi.mocked(window.setInterval).mock.calls.find(([, delay]) => delay === 5000)![0] as () => Promise<void>
  const original = vi.mocked(fetch).getMockImplementation()!
  const replies: ((response: Response) => void)[] = []
  vi.mocked(fetch).mockImplementation((input, init) => String(input).endsWith('/driver/health')
    ? new Promise<Response>(resolve => replies.push(resolve)) : original(input, init))
  const first = poll()
  const second = poll()
  replies[0](Response.json({ ...health, running: false, connected: false }))
  await first
  expect(document.querySelector('#btn-driver-toggle')?.textContent).toContain(i18n.t('printers.startDriver'))
  expect(document.querySelector('#health-text')?.textContent).not.toBe('Connected')
  replies[1](Response.json({ ...health, running: true, connected: true }))
  await second
  expect(document.querySelector('#btn-driver-toggle')?.textContent).toContain(i18n.t('printers.stopDriver'))
  const third = poll()
  replies[2](Response.json({ ...health, running: false, connected: true }))
  await third
  expect(document.querySelector('#btn-driver-toggle')?.textContent).toContain(i18n.t('printers.startDriver'))
})

it('shows a confirmed deletion after dismissing the preserved config draft', async () => {
  const original = vi.mocked(fetch).getMockImplementation()!
  let deleted = false
  vi.mocked(fetch).mockImplementation((input, init) => deleted && String(input) === '/api/v1/printers/4'
    ? Promise.resolve(Response.json({}, { status: 404 })) : original(input, init))
  document.querySelector<HTMLButtonElement>('#btn-edit-config')!.click()
  const form = document.querySelector<HTMLFormElement>('#config-form')!
  const url = form.querySelector<HTMLInputElement>('[name="url"]')!
  url.value = 'http://keep-this-draft.local'
  url.dispatchEvent(new Event('input', { bubbles: true }))
  deleted = true
  window.dispatchEvent(new CustomEvent('filaman:data-changed', { detail: { event: 'resync' } }))
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(document.querySelector('#config-form')).toBe(form)
  expect(url.value).toBe('http://keep-this-draft.local')
  document.querySelector<HTMLButtonElement>('#btn-cancel-config')!.click()
  expect((document.querySelector('#printer-content [role="alert"]')?.textContent ?? '')).toContain(i18n.t('printers.notFound'))
  expect(document.querySelector('#btn-delete, #btn-driver-toggle')).toBeNull()
  window.dispatchEvent(new CustomEvent('filaman:data-changed', { detail: { event: 'slots_update', printer_id: 4 } }))
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(document.querySelector('#btn-delete, #btn-driver-toggle')).toBeNull()
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

it.each(['resync', 'printer_update'])('sends one Sync command after repeated %s renders', async event => {
  for (let index = 0; index < 2; index++) {
    const reads = vi.mocked(fetch).mock.calls.filter(([path]) => String(path).endsWith('/driver/health')).length
    window.dispatchEvent(new CustomEvent('filaman:data-changed', { detail: { event, printer_id: 4 } }))
    await vi.waitFor(() => expect(vi.mocked(fetch).mock.calls.filter(([path]) => String(path).endsWith('/driver/health'))).toHaveLength(reads + 1))
  }
  document.querySelector<HTMLButtonElement>('.btn-sync-action')!.click()
  await vi.waitFor(() => expect(writes).toHaveLength(1))
  expect(JSON.parse(String(writes[0].body))).toEqual({ action: 'sync', params: {} })
})

it('refreshes slot assignments on a slots-only notice without replacing an open draft', async () => {
  document.querySelector<HTMLButtonElement>('#btn-edit-config')!.click()
  const input = document.querySelector<HTMLInputElement>('#config-form [name="url"]')!
  input.value = 'http://draft.local'
  input.dispatchEvent(new Event('input', { bubbles: true }))
  const original = vi.mocked(fetch).getMockImplementation()!
  vi.mocked(fetch).mockImplementation((path, init) => String(path) === '/api/v1/printers/4'
    ? Promise.resolve(Response.json({ ...printer, slots: [{ slot_no: 1, assignment: { present: true, spool_id: 9, spool_name: 'Red PLA' } }] }))
    : original(path, init))
  window.dispatchEvent(new CustomEvent('filaman:data-changed', { detail: { event: 'slots_update', printer_id: 4 } }))
  await vi.waitFor(() => expect(document.querySelector('a[href="/spools/9"]')?.textContent).toBe('Red PLA'))
  expect(document.querySelector('a[href="/spools/8"]')).toBeNull()
  expect(document.querySelector('#config-form [name="url"]')).toBe(input)
  expect(input.value).toBe('http://draft.local')
})
