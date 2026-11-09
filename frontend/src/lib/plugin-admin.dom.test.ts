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
let nextAvailability: Promise<Response> | undefined
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
  nextAvailability = undefined
  i18n.setLang('en')
  document.cookie = 'csrf_token=test-csrf'
  alert.mockClear()
  Object.assign(window, { __fmAlert: alert, __fmConfirm: vi.fn(async () => true) })
  vi.stubGlobal('fetch', vi.fn(async (input, init?: RequestInit) => {
    const path = String(input)
    calls.push({ path, init })
    if (path.endsWith('/available')) {
      const response = nextAvailability
      nextAvailability = undefined
      return response ?? Response.json(updates)
    }
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
  updates = [{ plugin_key: 'example', version: '2.0.0', description: 'Example', publisher: 'Example author', repository_url: 'https://github.com/example/plugin', min_filaman_version: '2.0.3', is_compatible: true, release_id: 'example-release', update_available: true }]
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
  expect(JSON.parse(String(write.init!.body))).toEqual({ plugin_key: 'example', version: '2.0.0', release_id: 'example-release' })
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
  const catalogIcon = '/api/v1/plugin-icons/example?v=1.0.1'
  updates = [{ plugin_key: 'example', name: 'Example', version: '2.0.0', description: 'Example', publisher: 'Example author', repository_url: 'https://github.com/example/plugin', min_filaman_version: '2.0.3', is_compatible: true, release_id: 'example-release', update_available: true, icon_url: catalogIcon }]
  let finish!: (response: Response) => void
  installError = new Promise(resolve => { finish = resolve })
  await boot()
  document.querySelector<HTMLButtonElement>('#btn-browse-plugins')!.click()
  const modal = document.querySelector<HTMLDialogElement>('#install-modal')!
  expect(modal.open).toBe(true)
  const release = await vi.waitFor(() => {
    const button = document.querySelector<HTMLButtonElement>('#catalog-list button')
    expect(button).not.toBeNull()
    return button!
  })
  expect(modal.querySelector('.catalog-card img')?.getAttribute('src')).toBe(catalogIcon)
  release.click()
  const submit = document.querySelector<HTMLButtonElement>('#install-submit')!
  expect(submit.disabled).toBe(false)
  const header = submit.closest('header')!
  expect(header.querySelector('#catalog-selection')?.textContent).toContain('Example author')
  document.querySelector('#install-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  expect(submit.disabled).toBe(true)
  expect(document.querySelector<HTMLButtonElement>('#install-cancel')!.disabled).toBe(true)
  modal.dispatchEvent(new Event('cancel', { cancelable: true }))
  expect(modal.open).toBe(true)
  finish(Response.json({ detail: 'Update unavailable' }, { status: 422 }))
  await vi.waitFor(() => expect(document.querySelector('#error-details')!.textContent).toBe('Update unavailable'))
  expect(submit.disabled).toBe(false)
  expect(document.activeElement).toBe(submit)
  expect(header.querySelector('[role="alert"]')?.textContent).toBe('Update unavailable')
  expect(document.querySelector('#catalog-selection')!.textContent).toContain('Example author')
  document.querySelector<HTMLButtonElement>('#install-cancel')!.click()
  expect(modal.open).toBe(false)
})

it.each(['browse', 'table'])('refreshes a stale release from the %s without retrying it', async surface => {
  const release = {
    plugin_key: 'example', name: 'Example', version: '2.0.0', description: 'Example', publisher: 'Example author',
    repository_url: 'https://github.com/example/plugin', min_filaman_version: '2.0.3',
    is_compatible: true, is_installed: true, release_id: 'old-release', update_available: true,
  }
  updates = [release]
  let rejectInstall!: (response: Response) => void
  installError = new Promise(resolve => { rejectInstall = resolve })
  await boot()
  const browse = surface === 'browse'
  document.querySelector<HTMLButtonElement>(browse ? '#btn-browse-plugins' : '#btn-check-updates')!.click()
  const selector = browse ? '#catalog-list button' : '.btn-update'
  const previous = await vi.waitFor(() => {
    const action = document.querySelector<HTMLButtonElement>(selector)
    expect(action?.textContent).toContain('2.0.0')
    return action!
  })
  previous.click()
  const confirm = document.querySelector<HTMLButtonElement>('#install-submit')!
  if (browse) document.querySelector('#install-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  await vi.waitFor(() => expect(calls.filter(call => call.init?.method === 'POST')).toHaveLength(1))

  const check = document.querySelector<HTMLButtonElement>('#btn-check-updates')!
  let finishOlderCheck: ((response: Response) => void) | undefined
  if (!browse) {
    nextAvailability = new Promise(resolve => { finishOlderCheck = resolve })
    check.click()
    await vi.waitFor(() => expect(calls.filter(call => call.path.endsWith('/available'))).toHaveLength(2))
  }

  updates = [{ ...release, version: '3.0.0', release_id: 'new-release' }]
  rejectInstall(Response.json({ detail: { code: 'catalog_release_unavailable' } }, { status: 409 }))
  await vi.waitFor(() => expect(document.querySelector(selector)?.textContent).toContain('3.0.0'))
  expect(document.querySelector(browse ? '#error-details' : '#plugin-message')?.textContent).toBe(i18n.t('admin.pluginCatalogChanged'))
  expect(previous.isConnected).toBe(false)
  if (browse) {
    expect(confirm.hidden).toBe(true)
    expect(document.activeElement?.id).toBe('catalog-search')
  } else {
    finishOlderCheck!(Response.json([release]))
    await vi.waitFor(() => expect(check.disabled).toBe(false))
    expect(document.querySelector(selector)?.textContent).toContain('3.0.0')
    expect(document.querySelector('#plugin-message')?.textContent).toBe(i18n.t('admin.pluginCatalogChanged'))
  }
  expect(calls.filter(call => call.init?.method === 'POST')).toHaveLength(1)
})

it('searches the catalog and confirms the chosen release by key and version', async () => {
  updates = [
    { plugin_key: 'moonraker_filaman', name: 'Moonraker', description: 'Connects Klipper printers', publisher: 'Fire-Devils', version: '0.2.5', repository_url: 'https://github.com/Fire-Devils/FilaMan-Moonraker-Plugin', min_filaman_version: '2.0.3', is_compatible: true, release_id: 'moonraker-release', is_installed: false },
    { plugin_key: 'bambuddy', name: 'Bambuddy', description: 'Syncs spool data', publisher: 'Fire-Devils', version: '1.3.10', repository_url: 'https://github.com/Fire-Devils/filaman-bambuddy-plugin', min_filaman_version: '2.0.3', is_compatible: true, is_installed: true },
  ]
  await boot()
  document.querySelector<HTMLButtonElement>('#btn-browse-plugins')!.click()
  const list = document.querySelector('#catalog-list')!
  await vi.waitFor(() => expect(list.textContent).toContain('Bambuddy'))
  const cards = [...list.children]
  expect(cards.map(card => card.querySelector('h3')?.textContent)).toEqual(['Bambuddy', 'Moonraker'])
  expect(cards.every(card => card.querySelector('.fm-plugin-icon[aria-hidden="true"]'))).toBe(true)
  expect(cards[0].querySelector('button')).toBeNull()
  expect(cards[0].querySelector('.catalog-installed')?.textContent).toContain(i18n.t('admin.pluginAlreadyInstalled'))
  expect(cards[1].querySelector('a')?.getAttribute('href')).toBe('https://github.com/Fire-Devils/FilaMan-Moonraker-Plugin')
  const search = document.querySelector<HTMLInputElement>('#catalog-search')!
  search.value = 'klipper'
  search.dispatchEvent(new Event('input'))
  expect(list.textContent).toContain('Moonraker')
  expect(list.textContent).not.toContain('Bambuddy')
  list.querySelector<HTMLButtonElement>('button')!.click()
  expect(list.querySelector('button')?.getAttribute('aria-current')).toBe('true')
  expect(document.querySelector('#catalog-selection')!.textContent).toContain('Fire-Devils')
  expect(calls.every(call => call.init?.method !== 'POST')).toBe(true)
  document.querySelector('#install-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  await vi.waitFor(() => expect(calls.some(call => call.init?.method === 'POST')).toBe(true))
  expect(JSON.parse(String(calls.find(call => call.init?.method === 'POST')!.init?.body))).toEqual({ plugin_key: 'moonraker_filaman', version: '0.2.5', release_id: 'moonraker-release' })
  await vi.waitFor(() => expect(document.querySelector('#plugin-message')?.textContent).toBe('Installed successfully'))
  expect(document.querySelector('#catalog-selection')?.hasAttribute('hidden')).toBe(true)
})

it('combines search and status filters and clears a hidden install selection', async () => {
  const release = {
    publisher: 'FilaMan', repository_url: 'https://github.com/example/plugin', version: '2.0.0',
    min_filaman_version: '2.0.3', is_compatible: true, release_id: 'example-release',
  }
  updates = [
    { ...release, plugin_key: 'current', name: 'Current', description: 'A driver', is_installed: true },
    { ...release, plugin_key: 'outdated', name: 'Outdated', description: 'A driver', is_installed: true, installed_version: '1.0.0', update_available: true },
    { ...release, plugin_key: 'new_plugin', name: 'New', description: 'An integration', is_installed: false },
  ]
  await boot()
  document.querySelector<HTMLButtonElement>('#btn-browse-plugins')!.click()
  const list = document.querySelector('#catalog-list')!
  await vi.waitFor(() => expect(list.children).toHaveLength(3))
  const filter = document.querySelector<HTMLSelectElement>('#catalog-filter')!
  const search = document.querySelector<HTMLInputElement>('#catalog-search')!
  const names = () => [...list.querySelectorAll('h3')].map(heading => heading.textContent)
  const setFilter = (value: string) => {
    filter.value = value
    filter.dispatchEvent(new Event('change'))
  }

  setFilter('installed')
  expect(names()).toEqual(['Current', 'Outdated'])
  setFilter('updates')
  expect(names()).toEqual(['Outdated'])
  expect(list.querySelector('.catalog-installed')?.textContent).toContain('v1.0.0')
  expect(list.querySelector('button')?.textContent).toBe(i18n.t('admin.pluginUpdateTo').replace('{version}', '2.0.0'))
  list.querySelector<HTMLButtonElement>('button')!.click()
  expect(document.querySelector('#catalog-selection')!.hasAttribute('hidden')).toBe(false)
  setFilter('uninstalled')
  expect(names()).toEqual(['New'])
  expect(document.querySelector('#catalog-selection')!.hasAttribute('hidden')).toBe(true)
  expect(document.querySelector<HTMLButtonElement>('#install-submit')!.disabled).toBe(true)

  search.value = 'driver'
  search.dispatchEvent(new Event('input'))
  expect(names()).toEqual([])
  expect(document.querySelector('#catalog-status')?.textContent).toBe(i18n.t('admin.pluginNoMatches'))
  setFilter('all')
  expect(names()).toEqual(['Current', 'Outdated'])
})

it('explains how to restore a newer recorded plugin when the catalog only has an older ZIP', async () => {
  updates = [{
    plugin_key: 'example', name: 'Example', description: 'Test plugin', publisher: 'Example author',
    version: '1.0.0', repository_url: 'https://github.com/example/plugin', min_filaman_version: '2.0.3',
    is_compatible: true, is_installed: false, installed_version: '2.0.0', requires_newer_zip: true,
  }]
  await boot()
  document.querySelector<HTMLButtonElement>('#btn-browse-plugins')!.click()
  const list = document.querySelector('#catalog-list')!
  await vi.waitFor(() => expect(list.textContent).toContain('Example'))
  expect(list.querySelector('button')).toBeNull()
  expect(list.textContent).toContain('Upload a ZIP for version 2.0.0 or newer')
})
