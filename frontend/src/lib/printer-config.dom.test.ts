// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { bootAstroPage } from '../../tests/helpers/astro-page'
import * as driver from './driver-config-form'
import * as state from './form-state'
import * as dialog from './form-dialog'
import * as i18n from './i18n'
import * as abort from './abort'
import { escapeHtml } from './extra-fields'
import { tableAction } from './table-actions'
import { copyText } from './clipboard'

const config = { url: 'http://printer.local', enabled: false, count: 0, mode: 'manual', targets: [{ slot: 1 }] }
const schema = {
  required: ['url', 'count', 'mode'],
  properties: {
    url: { type: 'string', title: 'Printer <URL>', description: 'Connection <address>', default: 'http://default' },
    enabled: { type: 'boolean', default: true },
    count: { type: 'integer', minimum: 0, maximum: 8, default: 4 },
    mode: { type: 'string', enum: ['auto', 'manual'], enumNames: ['Automatic', 'Manual <mode>'], default: 'auto' },
    timeout: { type: 'number', default: 5 },
    targets: { type: 'array' },
    'quoted"key': { type: 'string', default: '"value' },
  },
}

beforeEach(() => {
  i18n.setLang('en')
  window.history.replaceState({}, '', '/printers/4')
  vi.spyOn(window, 'addEventListener')
  vi.spyOn(document, 'addEventListener')
  vi.stubGlobal('fetch', vi.fn(async (input) => {
    const path = String(input)
    const printer = { id: 4, name: 'Example', driver_key: 'moonraker', is_active: true, driver_config: config }
    if (path.endsWith('/admin/system/plugins')) return Response.json([{ name: 'Moonraker', driver_key: 'moonraker', is_active: true, config_schema: schema }])
    if (path.endsWith('/driver/health')) return Response.json({ running: false })
    return Response.json(path.endsWith('/printers') ? { items: [printer] } : printer)
  }))
})
afterEach(() => {
  window.dispatchEvent(new Event('pagehide'))
  for (const [event, listener] of vi.mocked(window.addEventListener).mock.calls) window.removeEventListener(event, listener)
  for (const [event, listener] of vi.mocked(document.addEventListener).mock.calls) document.removeEventListener(event, listener)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  document.body.replaceChildren()
})

it.each(['index', '[id]'])('preserves schema controls, stored false/zero and defaults in printers/%s', async page => {
  await bootAstroPage(`printers/${page}`, { ...driver, ...state, ...dialog, ...i18n, ...abort, escapeHtml, tableAction, copyText, initI18n: async () => {} })
  const editSelector = page === 'index' ? '.btn-edit' : '#btn-edit-config'
  await vi.waitFor(() => expect(document.querySelector(editSelector)).not.toBeNull())
  document.querySelector<HTMLButtonElement>(editSelector)!.click()
  await vi.waitFor(() => expect(document.querySelector('#config-url')).not.toBeNull())
  const input = (key: string) => document.getElementById(`config-${key}`) as HTMLInputElement
  expect(input('url').value).toBe(config.url)
  expect(input('url').name).toBe('url')
  expect(input('url').required).toBe(true)
  expect(input('url').parentElement?.textContent).toContain('Printer <URL> *')
  expect(input('url').parentElement?.textContent).toContain('Connection <address>')
  expect(input('enabled').checked).toBe(false)
  expect(input('count').value).toBe('0')
  expect(input('count').type).toBe('number')
  expect(input('count').min).toBe('0')
  expect(input('count').max).toBe('8')
  expect(input('count').required).toBe(true)
  expect(input('timeout').value).toBe('5')
  const select = document.getElementById('config-mode') as HTMLSelectElement
  expect(select.value).toBe('manual')
  expect(select.required).toBe(true)
  expect(select.selectedOptions[0].textContent).toBe('Manual <mode>')
  expect(document.querySelector('[name="targets"]')).toBeNull()
  const fields = document.getElementById(page === 'index' ? 'config-fields' : 'config-form')!
  expect(fields.querySelector('pre')?.textContent).toContain('"slot": 1')
  expect(fields.textContent).toContain(i18n.t('printers.configReadOnly'))
  expect(fields.querySelector('a[href="/admin/system"]')?.textContent).toContain('moonraker')
  const quoted = [...fields.querySelectorAll<HTMLInputElement>('input')].find(input => input.name === 'quoted"key')
  expect(quoted?.id).toBe('config-quoted"key')
  expect(quoted?.value).toBe('"value')
  expect(fields.querySelector('address, url, mode')).toBeNull()
})
