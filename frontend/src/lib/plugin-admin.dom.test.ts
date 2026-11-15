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

const plugin = { plugin_key: 'example', name: 'Example plugin', icon_url: '/api/v1/plugin-icons/example?v=1.0.0', page_url: '/plugin-page/example', description: 'Connects printers. Shows print jobs and syncs spool usage.', version: '1.0', plugin_type: 'integration', author: '<b>Author</b>', is_active: true, installed_by: 1, installed_at: '2026-01-01' }
let panelController: AbortController
let updates: unknown[] = []
let installed = [plugin]
let installError: Response | Promise<Response> | undefined
let installResults: (Response | Promise<Response>)[]
let nextAvailability: Promise<Response> | undefined
let affectedPrinters: Promise<Response> | undefined
let uninstallResult: Promise<Response> | undefined
let failInstalledList = false
let nextInstalledList: Promise<Response> | undefined
let statusResponse: Promise<Response> | undefined
const calls: { path: string; init?: RequestInit }[] = []
const alert = vi.fn(async () => true)
const confirm = vi.fn<(message: string, options?: unknown) => Promise<boolean>>(async () => true)
function stageTwoUpdates() {
  const second = { ...plugin, plugin_key: 'second', name: 'Second plugin' }
  installed = [plugin, second]
  updates = installed.map(p => ({
    ...p, version: '2.0.0', publisher: 'Example author', release_id: p.plugin_key, update_available: true,
    repository_url: 'https://github.com/example/plugin', min_filaman_version: '2.0.3',
    is_compatible: true, is_installed: true,
  }))
  return second
}

function checkForUpdateAction(selector: string) {
  const check = document.querySelector<HTMLButtonElement>('#btn-check-updates')!
  check.click()
  return vi.waitFor(() => {
    const button = document.querySelector<HTMLButtonElement>(selector)
    expect(button?.hidden).toBe(false)
    expect(check.disabled).toBe(false)
    return button!
  })
}

function pauseInstall() {
  let finish!: (response: Response) => void
  installError = new Promise(resolve => { finish = resolve })
  return finish
}

async function openCatalogUpdate() {
  document.querySelector<HTMLButtonElement>('#btn-browse-plugins')!.click()
  return vi.waitFor(() => {
    const button = document.querySelector<HTMLButtonElement>('#catalog-list [data-release="example"]')
    expect(button).not.toBeNull()
    return button!
  })
}

async function bootPage() {
  const dependencies = { ...api, ...abort, ...nav, ...icons, ...escape, ...i18n, ...dialog, ...actions, initI18n: async () => {} }
  await bootAstroPage('admin/system', dependencies, panelController.signal)
}
async function boot() {
  await bootPage()
  await vi.waitFor(() => expect(document.querySelector('.btn-detail')).not.toBeNull())
}
beforeEach(() => {
  panelController = new AbortController()
  calls.length = 0
  updates = []
  installed = [plugin]
  installError = undefined
  installResults = []
  nextAvailability = undefined
  affectedPrinters = undefined
  uninstallResult = undefined
  failInstalledList = false
  nextInstalledList = undefined
  statusResponse = undefined
  i18n.setLang('en')
  document.cookie = 'csrf_token=test-csrf'
  alert.mockClear()
  confirm.mockReset().mockResolvedValue(true)
  Object.assign(window, { __fmAlert: alert, __fmConfirm: confirm })
  vi.stubGlobal('fetch', vi.fn(async (input, init?: RequestInit) => {
    const path = String(input)
    calls.push({ path, init })
    if (path.endsWith('/affected-printers')) return affectedPrinters ?? Response.json({ count: 0 })
    if (path.endsWith('/available')) {
      const response = nextAvailability
      nextAvailability = undefined
      return response ?? Response.json(updates)
    }
    if (path.endsWith('/install-from-registry')) return installResults.shift() ?? installError ?? Response.json({ plugin, message: 'Installed successfully' })
    if (init?.method === 'DELETE') return uninstallResult ?? new Response(null, { status: 204 })
    if (init?.method === 'PATCH') return statusResponse ?? Response.json({})
    if (path.endsWith('/system/plugins')) {
      const response = nextInstalledList
      nextInstalledList = undefined
      if (response) return response
      if (failInstalledList) return new Response(null, { status: 503 })
    }
    return Response.json(installed)
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
  expect(document.querySelector<HTMLButtonElement>('#btn-update-all')?.hidden).toBe(true)
  expect(document.querySelector('#btn-check-updates svg[aria-hidden="true"]')).not.toBeNull()
})

it('includes a plugin installed in another tab when checking for updates', async () => {
  stageTwoUpdates()
  const afterExternalInstall = installed
  installed = [plugin]
  await boot()
  expect(document.querySelector('.btn-detail[data-key="second"]')).toBeNull()
  installed = afterExternalInstall
  await checkForUpdateAction('#btn-update-all')
  expect(document.querySelector('.btn-update[data-key="second"]')).not.toBeNull()
  expect(document.querySelector('#plugin-message')?.textContent).toBe(i18n.t('admin.pluginUpdatesAvailable').replace('{count}', '2'))
})

it.each(['2.0.0', null])('reports an externally changed version %s even when no update remains', async installedVersion => {
  await boot()
  updates = [{ plugin_key: 'example', installed_version: installedVersion, update_available: false }]
  document.querySelector<HTMLButtonElement>('#btn-check-updates')!.click()
  await vi.waitFor(() => expect(document.querySelector('#plugin-message[role="alert"]')?.textContent).toBe(i18n.t('admin.pluginUpdateListChanged')))
  expect(document.querySelector('.btn-update')).toBeNull()
})

it('hides obsolete targets while keeping unchanged retries after a failed catalog check', async () => {
  const second = stageTwoUpdates()
  await boot()
  await checkForUpdateAction('#btn-update-all')
  installed = [{ ...plugin, version: '3.0.0' }, second]
  nextAvailability = Promise.resolve(Response.json({ detail: 'Catalog unavailable' }, { status: 502 }))
  const check = document.querySelector<HTMLButtonElement>('#btn-check-updates')!
  check.click()
  await vi.waitFor(() => expect(document.querySelector('#plugin-message[role="alert"]')?.textContent).toBe('Catalog unavailable'))
  expect(document.querySelector('#plugins-table .plugin-version')?.textContent).toBe('3.0.0')
  expect(document.querySelector('.btn-update[data-key="example"]')).toBeNull()
  expect(document.querySelector('.btn-update[data-key="second"]')).not.toBeNull()
  expect(document.querySelector<HTMLButtonElement>('#btn-update-all')!.hidden).toBe(false)
})

it('asks once for Update All, installs sequentially, and leaves a failed update available', async () => {
  const second = stageTwoUpdates()
  const postedKeys = () => calls.filter(call => call.init?.method === 'POST').map(call => JSON.parse(String(call.init?.body)).plugin_key)
  let finish!: (response: Response) => void
  installResults = [
    new Promise(resolve => { finish = resolve }),
    Response.json({ detail: 'Download unavailable' }, { status: 502 }),
  ]
  await boot()
  const all = document.querySelector<HTMLButtonElement>('#btn-update-all')!
  expect(all.hidden).toBe(true)
  document.querySelector<HTMLButtonElement>('#btn-check-updates')!.click()
  await vi.waitFor(() => expect(all.hidden).toBe(false))
  confirm.mockResolvedValueOnce(false)
  all.click()
  await vi.waitFor(() => expect(all.disabled).toBe(false))
  expect(postedKeys()).toEqual([])

  confirm.mockClear()
  all.click()
  expect(confirm).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('Second plugin v2.0.0'), expect.objectContaining({ okLabel: 'Update All' }))
  expect(confirm.mock.calls[0][0]).toContain('Example plugin v2.0.0')
  await vi.waitFor(() => expect(postedKeys()).toEqual(['example']))
  expect(document.querySelector<HTMLButtonElement>('.btn-update[data-key="second"]')!.disabled).toBe(true)
  installed = [{ ...plugin, version: '2.0.0' }, second]
  finish(Response.json({ plugin: installed[0], message: 'Updated successfully' }))
  await vi.waitFor(() => expect(document.querySelector('#plugins-table [role="alert"]')?.textContent).toBe('Download unavailable'))
  expect(postedKeys()).toEqual(['example', 'second'])
  expect(all.hidden).toBe(false)
  expect(document.querySelector<HTMLButtonElement>('.btn-update[data-key="second"]')!.disabled).toBe(false)
  expect(document.querySelector('.btn-update[data-key="example"]')).toBeNull()
})

it('updates eligible installed plugins from the Browse Plugins header regardless of search', async () => {
  const second = stageTwoUpdates()
  const [firstRelease, secondRelease] = updates as Record<string, unknown>[]
  const otherReleases = [
    { ...secondRelease, plugin_key: 'blocked', name: 'Blocked', requires_newer_zip: true },
    { ...secondRelease, plugin_key: 'new', name: 'New plugin', is_installed: false, update_available: false },
  ]
  updates = [{ ...firstRelease, is_installed: false }, secondRelease, ...otherReleases]
  const finishFirst = pauseInstall()
  installResults = [installError!, Response.json({ detail: 'Download unavailable' }, { status: 502 })]
  const posted = () => calls.filter(call => call.init?.method === 'POST').map(call => JSON.parse(String(call.init?.body)).plugin_key)
  await boot()
  await openCatalogUpdate()
  const close = document.querySelector<HTMLButtonElement>('#install-cancel')!
  const all = close.parentElement!.querySelector<HTMLButtonElement>('#catalog-update-all')!
  expect(all?.nextElementSibling).toBe(close)
  expect(all.hidden).toBe(false)
  const search = document.querySelector<HTMLInputElement>('#catalog-search')!
  search.value = 'Example plugin'
  search.dispatchEvent(new Event('input'))
  all.click()
  await vi.waitFor(() => expect(posted()).toEqual(['example']))
  expect(confirm).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('Second plugin v2.0.0'), expect.objectContaining({ okLabel: 'Update All' }))
  expect(close.disabled).toBe(true)
  installed = [{ ...plugin, version: '2.0.0' }, second]
  let finishCatalog!: (response: Response) => void
  let finishInstalledList!: (response: Response) => void
  nextAvailability = new Promise(resolve => { finishCatalog = resolve })
  nextInstalledList = new Promise(resolve => { finishInstalledList = resolve })
  finishFirst(Response.json({ plugin: installed[0] }))
  await vi.waitFor(() => expect(close.disabled).toBe(false))
  expect(posted()).toEqual(['example', 'second'])
  expect(document.querySelector('#error-details')?.textContent).toContain('Second plugin: Download unavailable')
  expect(all.hidden).toBe(false)
  expect(all.disabled).toBe(false)
  search.value = ''
  search.dispatchEvent(new Event('input'))
  expect(document.querySelector('#catalog-list [data-release="example"]')).toBeNull()
  expect(document.querySelector('#catalog-list [data-release="second"]')).not.toBeNull()
  finishCatalog(Response.json({ detail: 'Catalog unavailable' }, { status: 502 }))
  finishInstalledList(Response.json(installed))
  await vi.waitFor(() => expect(document.getElementById('catalog-retry')?.hidden).toBe(false))
  expect(document.querySelector('#catalog-list [data-release="second"]')).not.toBeNull()
})

it('keeps a failed catalog action confirmable while the batch refresh completes', async () => {
  const second = stageTwoUpdates()
  const [firstRelease, secondRelease] = updates as Record<string, unknown>[]
  const firstResult = pauseInstall()
  const upgraded = { ...plugin, version: '2.0.0' }
  installResults = [installError!, Response.json({ detail: 'Download unavailable' }, { status: 502 }),
    Response.json({ plugin: { ...second, version: '2.0.0' } })]
  const posts = () => calls.filter(call => call.init?.method === 'POST')
  await boot()
  await openCatalogUpdate()
  document.querySelector<HTMLButtonElement>('#catalog-update-all')!.click()
  await vi.waitFor(() => expect(posts()).toHaveLength(1))
  let finishRefresh!: (response: Response) => void
  nextAvailability = new Promise(resolve => { finishRefresh = resolve })
  updates = [{ ...firstRelease, update_available: false }, secondRelease]
  installed = [upgraded, second]
  firstResult(Response.json({ plugin: upgraded }))
  await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>('#install-cancel')!.disabled).toBe(false))

  let confirmRetry!: (confirmed: boolean) => void
  confirm.mockImplementationOnce(() => new Promise(resolve => { confirmRetry = resolve }))
  document.querySelector<HTMLButtonElement>('#catalog-list [data-release="second"]')!.click()
  finishRefresh(Response.json(updates))
  await new Promise(resolve => setTimeout(resolve, 0))
  updates = updates.map(release => ({ ...release as Record<string, unknown>, update_available: false }))
  confirmRetry(true)
  await vi.waitFor(() => expect(posts()).toHaveLength(3))
  expect(JSON.parse(String(posts()[2].init?.body)).plugin_key).toBe('second')
})

it.each(['batch', 'uninstall'])('blocks the other mutation while %s is pending', async first => {
  const second = stageTwoUpdates()
  await boot()
  document.querySelector<HTMLButtonElement>('#btn-check-updates')!.click()
  const all = document.querySelector<HTMLButtonElement>('#btn-update-all')!
  const remove = () => document.querySelector<HTMLButtonElement>('.btn-delete[data-key="second"]')!
  const mutations = () => calls.filter(call => ['POST', 'DELETE'].includes(call.init?.method ?? ''))
  await vi.waitFor(() => expect(all.hidden).toBe(false))

  let finish!: (response: Response) => void
  const pending = new Promise<Response>(resolve => { finish = resolve })
  if (first === 'batch') {
    installResults = [pending, Response.json({ plugin: { ...second, version: '2.0.0' } })]
    all.click()
  } else {
    uninstallResult = pending
    remove().click()
  }

  await vi.waitFor(() => expect(mutations()).toHaveLength(1))
  const competingAction = first === 'batch' ? remove() : all
  expect(competingAction.disabled).toBe(true)
  competingAction.click()

  if (first === 'batch') {
    installed = installed.map(p => ({ ...p, version: '2.0.0' }))
    finish(Response.json({ plugin: installed[0] }))
    await vi.waitFor(() => expect(remove().disabled).toBe(false))
    expect(mutations().map(call => call.init?.method)).toEqual(['POST', 'POST'])
  } else {
    installed = [plugin]
    finish(new Response(null, { status: 204 }))
    await vi.waitFor(() => expect(remove()).toBeNull())
    expect(all.hidden).toBe(false)
    expect(mutations().map(call => call.init?.method)).toEqual(['DELETE'])
  }
})

it('keeps successful changes and a failed update retry when refreshing the installed list fails', async () => {
  stageTwoUpdates()
  let finishSecond!: (response: Response) => void
  const upgraded = { ...plugin, version: '2.0.0' }
  installResults = [
    Response.json({ plugin: upgraded, message: 'Erfolgreich aktualisiert' }),
    new Promise(resolve => { finishSecond = resolve }),
  ]
  await boot()
  const all = await checkForUpdateAction('#btn-update-all')
  failInstalledList = true
  all.click()

  const retry = () => document.querySelector<HTMLButtonElement>('.btn-update[data-key="second"]')
  await vi.waitFor(() => expect(retry()?.textContent).toContain(i18n.t('admin.pluginUpdating')))
  expect(document.querySelector('#plugins-table .plugin-version')?.textContent).toBe(upgraded.version)
  finishSecond(Response.json({ detail: 'Download unavailable' }, { status: 502 }))
  await vi.waitFor(() => expect(retry()?.disabled).toBe(false))
  expect(document.querySelector('#plugin-message[role="alert"]')?.textContent).toBe(i18n.t('admin.pluginFailedLoad'))
  expect(document.querySelector('#plugins-table .plugin-version')?.textContent).toBe(upgraded.version)
  expect(document.querySelector('[data-update-message="example"]')?.textContent).toBe(`${i18n.t('common.successTitle')} · v2.0.0`)
  expect(document.querySelector('[data-update-message="second"][role="alert"]')?.textContent).toBe('Download unavailable')
})

it('removes a concurrently uninstalled batch target without retrying it as an install', async () => {
  stageTwoUpdates()
  const upgraded = { ...plugin, version: '2.0.0' }
  installResults = [
    Response.json({ plugin: upgraded }),
    Response.json({ detail: { code: 'catalog_plugin_uninstalled' } }, { status: 409 }),
  ]
  await boot()
  const all = await checkForUpdateAction('#btn-update-all')
  installed = [upgraded]
  all.click()

  await vi.waitFor(() => expect(document.querySelector('.btn-detail[data-key="second"]')).toBeNull())
  await vi.waitFor(() => expect(all.disabled).toBe(false))
  expect(document.querySelector('#plugin-message[role="alert"]')?.textContent).toBe(i18n.t('admin.pluginUpdateUninstalled'))
  expect(document.querySelector('[data-update-message="example"]')?.textContent).toContain('v2.0.0')
  expect(calls.filter(call => call.init?.method === 'POST').map(call => JSON.parse(String(call.init?.body)))).toEqual([
    { plugin_key: 'example', version: '2.0.0', release_id: 'example', update_only: true },
    { plugin_key: 'second', version: '2.0.0', release_id: 'second', update_only: true },
  ])
})

it('ignores a delayed initial list response after a confirmed catalog update', async () => {
  const second = stageTwoUpdates()
  let finishInitial!: (response: Response) => void
  nextInstalledList = new Promise(resolve => { finishInitial = resolve })
  installError = Response.json({ plugin: { ...plugin, version: '2.0.0' } })
  await bootPage()
  expect(document.querySelector<HTMLButtonElement>('#btn-update-all')!.hidden).toBe(true)
  const action = await openCatalogUpdate()
  failInstalledList = true
  action.click()
  const firstVersion = () => document.querySelector('.plugin-version')?.textContent
  await vi.waitFor(() => expect(firstVersion()).toBe('2.0.0'))
  finishInitial(Response.json([plugin, second]))
  await vi.waitFor(() => expect(document.querySelector('#plugin-message[role="alert"]')?.textContent).toBe(i18n.t('admin.pluginFailedLoad')))
  expect(firstVersion()).toBe('2.0.0')
  expect(document.querySelector<HTMLButtonElement>('#btn-update-all')!.hidden).toBe(true)
})

it.each(['toggle', 'uninstall'])('replaces a stale list read after a successful %s', async action => {
  const second = stageTwoUpdates()
  let finishInitial!: (response: Response) => void
  let finishBackground!: (response: Response) => void
  nextInstalledList = new Promise(resolve => { finishInitial = resolve })
  installError = Response.json({ plugin: { ...plugin, version: '2.0.0' }, message: 'Installed successfully' })
  await bootPage()
  const install = await openCatalogUpdate()
  nextInstalledList = new Promise(resolve => { finishBackground = resolve })
  install.click()
  await vi.waitFor(() => expect(document.querySelector('#validation-details')?.textContent).toBe('Installed successfully'))
  document.querySelector<HTMLButtonElement>('#install-cancel')!.click()
  installed = action === 'toggle' ? [{ ...plugin, version: '2.0.0', is_active: false }, second] : [second]
  const button = action === 'toggle' ? '.toggle-active' : '.btn-delete'
  document.querySelector<HTMLElement>(button)!.click()
  await vi.waitFor(() => expect(calls.some(call => ['PATCH', 'DELETE'].includes(call.init?.method ?? ''))).toBe(true))
  finishInitial(Response.json([plugin, second]))
  finishBackground(Response.json([{ ...plugin, version: '2.0.0' }, second]))

  await vi.waitFor(() => expect(document.querySelector('#plugins-table')?.textContent).toContain(second.name))
  expect(calls.filter(call => call.path.endsWith('/system/plugins'))).toHaveLength(3)
  if (action === 'toggle') expect(document.querySelector<HTMLInputElement>('.toggle-active[data-key="example"]')?.checked).toBe(false)
  else expect(document.querySelector('.btn-detail[data-key="example"]')).toBeNull()
})

it('returns focus to the current Details button after an update redraws its row', async () => {
  const second = stageTwoUpdates()
  const finish = pauseInstall()
  await boot()
  const update = await checkForUpdateAction('.btn-update[data-key="example"]')
  update.click()
  await vi.waitFor(() => expect(calls.some(call => call.init?.method === 'POST')).toBe(true))
  const details = () => document.querySelector<HTMLButtonElement>('.btn-detail[data-key="second"]')!
  const opener = details()
  opener.focus()
  opener.click()
  const modal = document.querySelector<HTMLDialogElement>('#detail-modal')!
  expect(modal.open).toBe(true)
  installed = [{ ...plugin, version: '2.0.0' }, second]
  finish(Response.json({ plugin: installed[0] }))
  await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>('#btn-browse-plugins')!.disabled).toBe(false))
  expect(details()).not.toBe(opener)
  modal.querySelector<HTMLButtonElement>('[data-dialog-close]')!.click()
  expect(modal.open).toBe(false)
  expect(document.activeElement).toBe(details())
})

it('reconciles a pending deactivation with the current row after an update redraw', async () => {
  stageTwoUpdates()
  const finishUpdate = pauseInstall()
  let finishStatus!: (response: Response) => void
  statusResponse = new Promise(resolve => { finishStatus = resolve })
  await boot()
  const update = await checkForUpdateAction('.btn-update[data-key="example"]')
  update.click()
  const toggle = () => document.querySelector<HTMLInputElement>('.toggle-active[data-key="second"]')!
  const original = toggle()
  original.click()
  await vi.waitFor(() => expect(calls.some(call => call.init?.method === 'PATCH')).toBe(true))
  failInstalledList = true
  finishUpdate(Response.json({ plugin: { ...plugin, version: '2.0.0' } }))
  await vi.waitFor(() => expect(toggle()).not.toBe(original))
  finishStatus(Response.json({ is_active: false }))

  await vi.waitFor(() => expect(toggle().disabled).toBe(false))
  expect(toggle().checked).toBe(false)
  expect(toggle().closest('.plugin-state')?.querySelector('.plugin-mobile-label')?.textContent).toBe(i18n.t('common.inactive'))
})

it('preserves a newer deactivation when the same plugin update response arrives late', async () => {
  stageTwoUpdates()
  const finishUpdate = pauseInstall()
  await boot()
  const update = await checkForUpdateAction('.btn-update[data-key="example"]')
  update.click()
  await vi.waitFor(() => expect(calls.some(call => call.init?.method === 'POST')).toBe(true))
  const row = () => document.querySelector('.btn-detail[data-key="example"]')!.closest('tr')!
  const toggle = () => row().querySelector<HTMLInputElement>('.toggle-active')!
  toggle().click()
  await vi.waitFor(() => expect(toggle().disabled).toBe(false))
  expect(toggle().checked).toBe(false)
  failInstalledList = true
  finishUpdate(Response.json({ plugin: { ...plugin, version: '2.0.0', is_active: true } }))

  await vi.waitFor(() => expect(document.querySelector('#plugin-message[role="alert"]')?.textContent).toBe(i18n.t('admin.pluginFailedLoad')))
  expect(row().querySelector('.plugin-version')?.textContent).toBe('2.0.0')
  expect(toggle().checked).toBe(false)
  expect(row().querySelector('.plugin-state .plugin-mobile-label')?.textContent).toBe(i18n.t('common.inactive'))
})

it('restores keyboard focus when an uninstall fails', async () => {
  let finish!: (response: Response) => void
  uninstallResult = new Promise(resolve => { finish = resolve })
  await boot()
  const remove = document.querySelector<HTMLButtonElement>('.btn-delete')!
  remove.focus()
  remove.click()
  await vi.waitFor(() => expect(remove.disabled).toBe(true))
  document.body.tabIndex = -1
  document.body.focus()
  expect(document.activeElement).toBe(document.body)
  finish(Response.json({ detail: 'Uninstall unavailable' }, { status: 503 }))
  await vi.waitFor(() => expect(remove.disabled).toBe(false))
  expect(document.activeElement).toBe(remove)
  document.body.removeAttribute('tabindex')
})

it('unlocks the catalog after install even while the installed list refresh is pending', async () => {
  stageTwoUpdates()
  let finishRefresh!: (response: Response) => void
  await boot()
  nextInstalledList = new Promise(resolve => { finishRefresh = resolve })
  const action = await openCatalogUpdate()
  action.click()
  const close = document.querySelector<HTMLButtonElement>('#install-cancel')!
  await vi.waitFor(() => expect(document.querySelector('#validation-details')?.textContent).toBe('Installed successfully'))
  expect(close.disabled).toBe(false)
  close.click()
  expect(document.querySelector<HTMLDialogElement>('#install-modal')!.open).toBe(false)
  finishRefresh(Response.json(installed))
})

it('confirms each plugin separately and prevents a second update from overlapping the first', async () => {
  const second = stageTwoUpdates()
  const finish = pauseInstall()
  await boot()
  const first = await checkForUpdateAction('.btn-update[data-key="example"]')
  first.click()
  const secondButton = () => document.querySelector<HTMLButtonElement>('.btn-update[data-key="second"]')!
  expect(confirm).toHaveBeenCalledWith('Update Example plugin to v2.0.0 from Example author?', expect.anything())
  expect(secondButton().disabled).toBe(true)
  expect(document.querySelector<HTMLButtonElement>('#btn-browse-plugins')!.disabled).toBe(true)
  secondButton().click()
  await vi.waitFor(() => expect(calls.filter(call => call.init?.method === 'POST')).toHaveLength(1))
  expect(confirm).toHaveBeenCalledTimes(1)

  installed = [{ ...plugin, version: '2.0.0' }, second]
  installError = Response.json({ plugin: { ...second, version: '2.0.0' }, message: 'Updated successfully' })
  finish(Response.json({ plugin: installed[0], message: 'Updated successfully' }))
  await vi.waitFor(() => expect(secondButton().disabled).toBe(false))
  secondButton().click()
  expect(confirm).toHaveBeenLastCalledWith('Update Second plugin to v2.0.0 from Example author?', expect.anything())
  await vi.waitFor(() => expect(calls.filter(call => call.init?.method === 'POST').map(call => JSON.parse(String(call.init?.body)).plugin_key)).toEqual(['example', 'second']))
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
  const row = document.querySelector('.btn-update')!.closest('tr')!
  await vi.waitFor(() => expect(row.querySelector('[role="alert"]')?.textContent).toBe(message))
  const button = document.querySelector<HTMLButtonElement>('.btn-update')!
  expect(button.disabled).toBe(false)
  expect(button.textContent).toContain('2.0')
  expect(button.querySelector('svg[aria-hidden="true"]')).not.toBeNull()
  expect(document.querySelector('#plugin-message')!.getAttribute('role')).toBe('status')
  const write = calls.find(call => call.init?.method === 'POST')!
  expect(write.path).toBe('/api/v1/admin/system/plugins/install-from-registry')
  expect(JSON.parse(String(write.init!.body))).toEqual({ plugin_key: 'example', version: '2.0.0', release_id: 'example-release', update_only: true })
  expect((write.init!.headers as Record<string, string>)['X-CSRF-Token']).toBe('test-csrf')
})
it('reconciles the installed version before showing the replacement for an unavailable release', async () => {
  stageTwoUpdates()
  const finish = pauseInstall()
  await boot()
  const update = await checkForUpdateAction('.btn-update[data-key="example"]')
  update.click()
  await vi.waitFor(() => expect(calls.some(call => call.init?.method === 'POST')).toBe(true))
  installed = [{ ...plugin, version: '3.0.0' }]
  updates = [{ plugin_key: 'example', installed_version: '3.0.0', version: '4.0.0', release_id: 'replacement', update_available: true }]
  finish(Response.json({ detail: { code: 'catalog_release_unavailable' } }, { status: 409 }))

  await vi.waitFor(() => expect(document.querySelector('.btn-update[data-key="example"]')?.textContent).toBe('Update to v4.0.0'))
  expect(document.querySelector('#plugins-table .plugin-version')?.textContent).toBe('3.0.0')
  expect(document.querySelector('#plugins-table [role="alert"]')?.textContent).toBe(i18n.t('admin.pluginCatalogChanged'))
})

it('offers a named link to the plugin page beside the row actions', async () => {
  await boot()
  const open = document.querySelector<HTMLAnchorElement>('#plugins-table .plugin-actions a')!
  expect(open.getAttribute('href')).toBe('/plugin-view?p=example')
  expect(open.getAttribute('aria-label')).toBe('Open Example plugin')
  expect(open.title).toBe('Open Example plugin')
  expect(open.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true')
  expect(open.textContent?.trim()).toBe('Open')
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

it('keeps the catalog action available after failure and blocks closing while installing', async () => {
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
  let respond!: (confirmed: boolean) => void
  confirm.mockImplementationOnce(() => new Promise(resolve => { respond = resolve }))
  release.click()
  expect(confirm).toHaveBeenCalledWith('Update Example to v2.0.0 from Example author?', {
    title: 'Confirm update', okLabel: 'Update to v2.0.0', isDanger: false,
  })
  expect(release.hidden).toBe(false)
  expect(document.querySelector<HTMLButtonElement>('#install-submit')!.hidden).toBe(true)
  expect(calls.every(call => call.init?.method !== 'POST')).toBe(true)
  respond(true)
  await vi.waitFor(() => expect(release.disabled).toBe(true))
  expect(modal.querySelector('#catalog-progress')?.textContent).toBe(i18n.t('admin.pluginUpdating'))
  expect(release.querySelector('svg[aria-hidden="true"]')).not.toBeNull()
  expect(document.querySelector<HTMLButtonElement>('#install-cancel')!.disabled).toBe(true)
  modal.dispatchEvent(new Event('cancel', { cancelable: true }))
  expect(modal.open).toBe(true)
  finish(Response.json({ detail: 'Update unavailable' }, { status: 422 }))
  await vi.waitFor(() => expect(document.querySelector('#error-details')?.textContent).toBe('Update unavailable'))
  expect(release.disabled).toBe(false)
  expect(release.querySelector('svg[aria-hidden="true"]')).not.toBeNull()
  expect(modal.querySelector('#catalog-progress')?.textContent).toBe('')
  expect(document.activeElement).toBe(release)
  document.querySelector<HTMLButtonElement>('#install-cancel')!.click()
  expect(modal.open).toBe(false)
})

it('keeps a delayed deactivation from interrupting catalog confirmation', async () => {
  updates = [{
    plugin_key: 'example', name: 'Example', version: '2.0.0', description: 'Example',
    publisher: 'Example author', repository_url: 'https://github.com/example/plugin',
    min_filaman_version: '2.0.3', is_compatible: true, release_id: 'example-release',
    is_installed: true, update_available: true,
  }]
  let showAffected!: (response: Response) => void
  affectedPrinters = new Promise(resolve => { showAffected = resolve })
  await boot()
  const toggle = document.querySelector<HTMLInputElement>('.toggle-active')!
  toggle.click()
  await vi.waitFor(() => expect(calls.some(call => call.path.endsWith('/affected-printers'))).toBe(true))
  document.querySelector<HTMLButtonElement>('#btn-browse-plugins')!.click()
  const action = await vi.waitFor(() => {
    const button = document.querySelector<HTMLButtonElement>('#catalog-list button')
    expect(button).not.toBeNull()
    return button!
  })
  let reply!: (confirmed: boolean) => void
  const overlay = document.createElement('dialog')
  overlay.id = 'fm-confirm-overlay'
  document.body.append(overlay)
  confirm.mockImplementationOnce(() => new Promise(resolve => {
    overlay.showModal()
    reply = confirmed => {
      overlay.close()
      resolve(confirmed)
    }
  }))
  action.click()
  showAffected(Response.json({ count: 1 }))
  await vi.waitFor(() => expect(toggle.checked).toBe(true))
  expect(confirm).toHaveBeenCalledTimes(1)
  expect(calls.some(call => call.init?.method === 'PATCH')).toBe(false)
  reply(true)
  await vi.waitFor(() => expect(calls.some(call => call.init?.method === 'POST')).toBe(true))
})

it.each(['browse', 'installed list'])('refreshes a stale release from the %s without retrying it', async surface => {
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
  expect(document.querySelector(browse ? '#error-details' : '#plugins-table [role="alert"]')?.textContent).toBe(i18n.t('admin.pluginCatalogChanged'))
  expect(previous.isConnected).toBe(false)
  if (browse) {
    expect(document.querySelector<HTMLButtonElement>('#install-submit')!.hidden).toBe(true)
    expect(document.activeElement?.id).toBe('catalog-search')
  } else {
    finishOlderCheck!(Response.json([release]))
    await vi.waitFor(() => expect(check.disabled).toBe(false))
    expect(document.querySelector(selector)?.textContent).toContain('3.0.0')
    expect(document.querySelector('#plugins-table [role="alert"]')?.textContent).toBe(i18n.t('admin.pluginCatalogChanged'))
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
  expect(cards[0].querySelector('.catalog-version')?.textContent).toBe('v1.3.10')
  expect(cards[0].querySelector('.catalog-version-label')?.textContent).toBe('Installed')
  expect(cards[1].querySelector('.catalog-version-label')).toBeNull()
  expect(cards[1].querySelector('a')?.getAttribute('aria-label')).toBe('Fire-Devils · Moonraker · GitHub')
  expect(cards[1].querySelector('a')?.getAttribute('href')).toBe('https://github.com/Fire-Devils/FilaMan-Moonraker-Plugin')
  const search = document.querySelector<HTMLInputElement>('#catalog-search')!
  search.value = 'klipper'
  search.dispatchEvent(new Event('input'))
  expect(list.textContent).toContain('Moonraker')
  expect(list.textContent).not.toContain('Bambuddy')
  const install = list.querySelector<HTMLButtonElement>('button[data-release]')!
  let cancel!: (confirmed: boolean) => void
  confirm.mockImplementationOnce(() => new Promise(resolve => { cancel = resolve }))
  install.click()
  expect(confirm).toHaveBeenCalledWith('Install Moonraker v0.2.5 from Fire-Devils?', {
    title: 'Confirm install', okLabel: 'Install Plugin', isDanger: false,
  })
  expect(install.hidden).toBe(false)
  expect(calls.every(call => call.init?.method !== 'POST')).toBe(true)
  cancel(false)
  await Promise.resolve()
  expect(calls.every(call => call.init?.method !== 'POST')).toBe(true)
  expect(search.value).toBe('klipper')
  install.click()
  await vi.waitFor(() => expect(calls.some(call => call.init?.method === 'POST')).toBe(true))
  expect(JSON.parse(String(calls.find(call => call.init?.method === 'POST')!.init?.body))).toEqual({ plugin_key: 'moonraker_filaman', version: '0.2.5', release_id: 'moonraker-release' })
  await vi.waitFor(() => expect(document.querySelector('#plugin-message')?.textContent).toBe('Installed successfully'))
})

it('combines search and status filters', async () => {
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
  expect(list.querySelector('.catalog-version')?.textContent).toBe('v1.0.0')
  expect(list.querySelector('.catalog-version-label')?.textContent).toBe('Installed')
  expect(list.querySelector('.catalog-version')?.classList.contains('catalog-version-outdated')).toBe(true)
  expect(list.querySelector('.catalog-footer p')?.textContent).toBe('Requires FilaMan 2.0.3 or newer')
  expect(list.querySelector('.catalog-footer button')?.textContent).toBe('Update to v2.0.0')
  setFilter('uninstalled')
  expect(names()).toEqual(['New'])
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
  expect(list.querySelector('.catalog-version')?.textContent).toBe('v1.0.0')
  expect(list.querySelector('.catalog-version-label')).toBeNull()
})


it('does not start an update after navigating away during confirmation', async () => {
  stageTwoUpdates()
  await boot()
  const button = await checkForUpdateAction('.btn-update')
  let finish!: (confirmed: boolean) => void
  confirm.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  button.click()
  await vi.waitFor(() => expect(confirm).toHaveBeenCalledOnce())
  panelController.abort()
  finish(true)
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(calls.filter(call => call.path.endsWith('/install-from-registry'))).toHaveLength(0)
})

it('stops a batch after navigation and still announces the completed install', async () => {
  stageTwoUpdates()
  await boot()
  const button = await checkForUpdateAction('#btn-update-all')
  const finish = pauseInstall()
  const installedEvent = vi.fn()
  window.addEventListener('filaman:plugin-installed', installedEvent, { once: true })
  button.click()
  await vi.waitFor(() => expect(calls.filter(call => call.path.endsWith('/install-from-registry'))).toHaveLength(1))
  panelController.abort()
  finish(Response.json({ plugin: { ...plugin, version: '2.0.0' }, message: 'Updated' }))
  await vi.waitFor(() => expect(installedEvent).toHaveBeenCalledOnce())
  expect(calls.filter(call => call.path.endsWith('/install-from-registry'))).toHaveLength(1)
})
