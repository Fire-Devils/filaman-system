// @vitest-environment happy-dom
import { bootAstroPage } from '../../tests/helpers/astro-page'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as dialog from './form-dialog'
import * as api from './api'
import * as abort from './abort'
import * as nav from './plugin-nav'
import * as icons from './plugin-icon'
import * as escape from './extra-fields'
import * as i18n from './i18n'
import * as actions from './table-actions'

const plugin = { plugin_key: 'example', name: 'Example plugin', icon_url: '/api/v1/plugin-icons/example?v=1.0.0', page_url: '/plugin-page/example', description: '', version: '1.0', plugin_type: 'integration', author: '<b>Author</b>', is_active: true, installed_by: 1, installed_at: '2026-01-01' }
let updates: unknown[] = []
let installError: Response | Promise<Response> | undefined
const calls: { path: string; init?: RequestInit }[] = []
const alert = vi.fn(async () => true)
async function boot() {
  const dependencies = { ...api, ...abort, ...nav, ...icons, ...escape, ...i18n, ...dialog, ...actions, initI18n: async () => {} }
  await bootAstroPage('admin/system', dependencies)
  await vi.waitFor(() => expect(document.querySelector('.btn-detail')).not.toBeNull())
}
beforeEach(() => {
  calls.length = 0
  updates = []
  installError = undefined
  i18n.setLang('en')
  document.cookie = 'csrf_token=test-csrf'
  alert.mockClear()
  Object.assign(window, { __fmAlert: alert })
  vi.stubGlobal('fetch', vi.fn(async (input, init?: RequestInit) => {
    const path = String(input)
    calls.push({ path, init })
    if (path.endsWith('/available')) return Response.json(updates)
    if (path.endsWith('/install-from-registry')) return installError || Response.json({ plugin, message: 'Installed successfully' })
    return Response.json([plugin])
  }))
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren() })
it('reports successful update checks inline without an Error dialog or mutation', async () => {
  await boot()
  document.querySelector<HTMLButtonElement>('#btn-check-updates')!.click()
  await vi.waitFor(() => expect(document.querySelector('#plugin-message')?.textContent).toBe(i18n.t('admin.pluginUpToDate')))
  expect(alert).not.toHaveBeenCalled()
  expect(calls.every(call => !call.init?.method || call.init.method === 'GET')).toBe(true)
  expect(document.querySelector('#plugin-message')!.getAttribute('role')).toBe('status')
})
it.each([
  [Response.json({ detail: 'Dependency requires a newer FilaMan version' }, { status: 422 }), 'Dependency requires a newer FilaMan version'],
  [Response.json({ detail: { message: 'Download unavailable' } }, { status: 502 }), 'Download unavailable'],
  [new Response('Proxy failed', { status: 502 }), 'HTTP 502'],
])('preserves an update failure reason and restores the retry button (%#)', async (response, message) => {
  updates = [{ plugin_key: 'example', version: '2.0', download_url: 'https://filaman.app/example.zip', update_available: true }]
  installError = response
  await boot()
  document.querySelector<HTMLButtonElement>('#btn-check-updates')!.click()
  await vi.waitFor(() => expect(document.querySelector('.btn-update')).not.toBeNull())
  document.querySelector<HTMLButtonElement>('.btn-update')!.click()
  await vi.waitFor(() => expect(document.querySelector('#plugin-message')?.textContent).toBe(message))
  const button = document.querySelector<HTMLButtonElement>('.btn-update')!
  expect(button.disabled).toBe(false)
  expect(button.textContent).toContain('2.0')
  expect(document.querySelector('#plugin-message')!.getAttribute('role')).toBe('alert')
  const write = calls.find(call => call.init?.method === 'POST')!
  expect(write.path).toBe('/api/v1/admin/system/plugins/install-from-registry')
  expect(JSON.parse(String(write.init!.body))).toEqual({ download_url: 'https://filaman.app/example.zip' })
  expect((write.init!.headers as Record<string, string>)['X-CSRF-Token']).toBe('test-csrf')
})
it('offers a named icon link to the plugin page beside the row actions', async () => {
  await boot()
  const open = document.querySelector<HTMLAnchorElement>('#plugins-table .plugin-actions a')!
  expect(open.getAttribute('href')).toBe('/plugin-view?p=example')
  expect(open.getAttribute('aria-label')).toBe('Open Example plugin')
  expect(open.title).toBe('Open Example plugin')
  expect(open.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true')
  expect(open.textContent?.trim()).toBe('')
})
it('opens native details with plugin metadata rendered as text', async () => {
  await boot()
  document.querySelector<HTMLButtonElement>('.btn-detail')!.click()
  const details = document.querySelector<HTMLDialogElement>('#detail-modal')!
  expect(details.open).toBe(true)
  expect(details.textContent).toContain('<b>Author</b>')
  expect(document.querySelector<HTMLImageElement>('#plugins-table .fm-plugin-icon img')?.getAttribute('src')).toBe(plugin.icon_url)
  expect(details.querySelector<HTMLImageElement>('.fm-plugin-icon img')?.getAttribute('src')).toBe(plugin.icon_url)
  for (const icon of document.querySelectorAll('.fm-plugin-icon')) icon.querySelector('img')?.dispatchEvent(new Event('load'))
  expect(document.querySelector<HTMLElement>('#plugins-table .fm-plugin-icon-mask')?.style.maskImage).toContain(plugin.icon_url)
  expect(details.querySelector<HTMLElement>('.fm-plugin-icon-mask')?.style.maskImage).toContain(plugin.icon_url)
  expect(details.querySelector('b')).toBeNull()
  document.querySelector<HTMLButtonElement>('#detail-close')!.click()
  expect(details.open).toBe(false)
})

it('keeps install selection available after failure and blocks closing while installing', async () => {
  updates = [{ plugin_key: 'example', name: 'Example', version: '2.0', download_url: 'https://filaman.app/example.zip', update_available: true }]
  let finish!: (response: Response) => void
  installError = new Promise(resolve => { finish = resolve })
  await boot()
  document.querySelector<HTMLButtonElement>('#btn-install')!.click()
  const modal = document.querySelector<HTMLDialogElement>('#install-modal')!
  expect(modal.open).toBe(true)
  await vi.waitFor(() => expect(document.querySelectorAll('#registry-select option')).toHaveLength(2))
  const registry = document.querySelector<HTMLSelectElement>('#registry-select')!
  registry.value = 'https://filaman.app/example.zip'
  registry.dispatchEvent(new Event('change'))
  const submit = document.querySelector<HTMLButtonElement>('#install-submit')!
  expect(submit.disabled).toBe(false)
  document.querySelector('#install-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  expect(submit.disabled).toBe(true)
  expect(document.querySelector<HTMLButtonElement>('#install-cancel')!.disabled).toBe(true)
  modal.dispatchEvent(new Event('cancel', { cancelable: true }))
  expect(modal.open).toBe(true)
  finish(Response.json({ detail: 'Update unavailable' }, { status: 422 }))
  await vi.waitFor(() => expect(document.querySelector('#error-details')!.textContent).toBe('Update unavailable'))
  expect(submit.disabled).toBe(false)
  expect(registry.value).toBe('https://filaman.app/example.zip')
  document.querySelector<HTMLButtonElement>('#install-cancel')!.click()
  expect(modal.open).toBe(false)
})
