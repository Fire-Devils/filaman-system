// @vitest-environment happy-dom
import { bootAstroPage } from '../../tests/helpers/astro-page'
import { afterEach, expect, it, vi } from 'vitest'
import { bindFormDialog } from './form-dialog'
import { escapeHtml } from './extra-fields'
import { hasPermission } from './auth'

interface DashboardActions {
  openSpoolModal: (type: 'problem') => Promise<void>
  closeSpoolModal: () => void
  archiveSpool: (id: number) => Promise<void>
  archiveAll: (ids: number[]) => Promise<void>
}

async function boot(canArchive = false) {
  const fetch = vi.fn(async (_path: string, init?: RequestInit) => init?.method
    ? Response.json({ detail: 'Not permitted' }, { status: 403 })
    : Response.json({ spool_distribution: { full: 0, normal: 0, low: 1, critical: 0, empty: 0 }, filament_count_active: 1, filament_count_used: 0, total_value_available: 3, manufacturers_with_spools: [{ id: 7, name: 'Maker <clear>', spool_count: 2 }], low_stock_spools: [{ spool_id: 3, filament_designation: 'Sample', filament_type: 'PLA', manufacturer_name: 'Maker', remaining_weight_g: 50 }], filament_types: [{ material_type: 'Empty-only type', count: 4 }], location_stats: [{ location_id: 9, location_name: 'Dry <box>', spool_count: 4, total_weight_g: 2500 }], filament_stats: [{ filament_type: 'PLA', spool_count: 2, total_weight_g: 1500 }, { filament_type: 'PETG <clear>', spool_count: 1, total_weight_g: 250 }] }))
  const dependencies = {
    t: (key: string) => key, initI18n: async () => {}, getLang: () => 'en',
    formatPrice: (value: number) => `€${value}`, getCurrency: () => 'EUR', initCurrency: async () => {},
    VERSION: '', changelogData: { versions: [] },
    cachedFetchAllPages: async (_key: string, path: string) => path.includes('filaments')
      ? { items: [{ id: 2, designation: '<img src=x onerror=alert(1)>', material_type: 'PLA' }], total: 2 }
      : { items: [{ id: 3, filament_id: 2, remaining_weight_g: 50, low_weight_threshold_g: 100 }], total: 1 },
    fetchSequential: async (jobs: (() => Promise<unknown>)[]) => { const result = []; for (const job of jobs) result.push(await job()); return result },
    CACHE_KEYS: { FILAMENTS: 'filaments' }, getAbortSignal: () => undefined,
    isAbortError: () => false,
    getMe: async () => ({ is_superadmin: false, permissions: canArchive ? ['spool_events:create_status'] : [] }), hasPermission,
    bindFormDialog, escapeHtml, fetch,
  }
  await bootAstroPage('index', dependencies)
  await vi.waitFor(() => expect(document.querySelector('#stat-total-spools')!.textContent).toBe('1'))
  return fetch
}
afterEach(() => { vi.restoreAllMocks(); document.body.replaceChildren(); localStorage.clear() })

it('renders safe material statistics and scope controls, and opens a read-only drilldown without archive permission', async () => {
  await boot()
  expect(document.querySelector('#filament-types')).toBeNull()
  const rows = [...document.querySelectorAll('#filament-stats tbody tr')]
  expect(rows.map(row => [...row.querySelectorAll('td')].map(cell => cell.textContent)))
    .toEqual([['PLA', '2', '1.5 kg'], ['PETG <clear>', '1', '250 g']])
  expect(rows[1].querySelector('a')!.getAttribute('href')).toBe('/spools?material=PETG%20%3Cclear%3E')
  expect(document.querySelector('#filament-stats')!.textContent).not.toContain('Empty-only type')

  document.querySelector<HTMLButtonElement>('[data-scope="active"]')!.click()
  expect(document.querySelector('#stat-total-filaments')!.textContent).toBe('1')
  expect(document.querySelector('[data-scope="active"]')!.getAttribute('aria-pressed')).toBe('true')
  const opener = document.querySelector<HTMLButtonElement>('#problem-spools')!
  opener.focus()
  opener.click()
  await vi.waitFor(() => expect(document.querySelector<HTMLDialogElement>('#spool-modal')!.open).toBe(true))
  expect(document.querySelector('#modal-content img')).toBeNull()
  expect(document.querySelector('#modal-content')!.textContent).toContain('<img src=x onerror=alert(1)>')
  expect(document.querySelector('#modal-content a')!.getAttribute('href')).toBe('/spools/3')
  expect(document.querySelector('#modal-content button')).toBeNull()
  expect(document.querySelector('#modal-footer')!.classList.contains('hidden')).toBe(true)
  document.querySelector<HTMLDialogElement>('#spool-modal')!.dispatchEvent(new Event('cancel', { cancelable: true }))
  expect(document.querySelector<HTMLDialogElement>('#spool-modal')!.open).toBe(false)
  expect(document.activeElement).toBe(opener)
})

it('labels manufacturer counts and preserves safe manufacturer drilldowns', async () => {
  await boot()
  const table = document.querySelector('#manufacturers-with-spools')!
  expect([...table.querySelectorAll('th')].map(cell => cell.textContent)).toEqual(['dashboard.manufacturer', 'dashboard.spools'])
  expect(table.querySelector('a')!.textContent).toBe('Maker <clear>')
  expect(table.querySelector('a')!.getAttribute('href')).toBe('/spools?manufacturer_id=7')
  expect(table.querySelector('td:last-child')!.textContent).toBe('2')
})

it('renders compact location summaries with safe names, counts, weights and drilldowns', async () => {
  await boot()
  const location = document.querySelector('#location-stats li')!
  expect(location.querySelector('a')!.textContent).toBe('Dry <box>')
  expect(location.querySelector('a')!.getAttribute('href')).toBe('/spools?location_id=9')
  expect([...location.querySelectorAll('span')].map(span => span.textContent)).toEqual(['4 dashboard.spools', '2.5 kg'])
  expect(location.querySelector('box')).toBeNull()
})

it('retains the archive request contract and leaves failed rows available for retry', async () => {
  const fetch = await boot(true)
  ;(window as unknown as { __fmConfirm: () => Promise<boolean>; __fmAlert: () => Promise<boolean> }).__fmConfirm = vi.fn(async () => true)
  ;(window as unknown as { __fmAlert: () => Promise<boolean> }).__fmAlert = vi.fn(async () => true)
  document.querySelector<HTMLButtonElement>('#problem-spools')!.click()
  await vi.waitFor(() => expect(document.querySelector<HTMLDialogElement>('#spool-modal')!.open).toBe(true))
  await (window as unknown as { archiveSpool: (id: number) => Promise<void> }).archiveSpool(3)
  const write = fetch.mock.calls.find(([, init]) => init?.method === 'POST')!
  expect(write[0]).toBe('/api/v1/spools/3/status')
  expect(JSON.parse(String(write[1]!.body))).toEqual({ status: 'archived' })
  expect(document.querySelector<HTMLButtonElement>('#modal-content button')!.disabled).toBe(false)
  expect(document.querySelector<HTMLDialogElement>('#spool-modal')!.open).toBe(true)
})

it.each(['single', 'bulk'] as const)('blocks dismissal and competing archives while a %s archive is pending', async kind => {
  const fetch = await boot(true)
  let confirmArchive!: (confirmed: boolean) => void
  const confirm = vi.fn(() => new Promise<boolean>(resolve => { confirmArchive = resolve }))
  Object.assign(window, { __fmConfirm: confirm })
  const actions = window as unknown as DashboardActions
  const opener = document.querySelector<HTMLButtonElement>('#problem-spools')!
  opener.focus()
  await actions.openSpoolModal('problem')
  const modal = document.querySelector<HTMLDialogElement>('#spool-modal')!
  const row = document.querySelector('#modal-content tbody tr')!
  let finish!: (response: Response) => void
  fetch.mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve }))
  const request = kind === 'bulk' ? actions.archiveAll([3]) : actions.archiveSpool(3)
  await actions.archiveAll([3])
  await actions.archiveSpool(3)
  expect(confirm).toHaveBeenCalledTimes(1)
  expect(modal.getAttribute('aria-busy')).toBe('true')
  confirmArchive(true)
  await vi.waitFor(() => expect(fetch.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true))

  modal.dispatchEvent(new Event('cancel', { cancelable: true }))
  expect(modal.open).toBe(true)
  modal.click()
  actions.closeSpoolModal()
  document.querySelector<HTMLButtonElement>('#spool-modal [data-dialog-close]')!.click()
  await actions.openSpoolModal('problem')
  await actions.archiveAll([3])
  await actions.archiveSpool(3)
  expect(modal.open).toBe(true)
  expect(document.querySelector('#modal-content tbody tr')).toBe(row)
  expect(modal.getAttribute('aria-busy')).toBe('true')
  expect([...modal.querySelectorAll('button')].every(button => button.disabled)).toBe(true)
  expect(confirm).toHaveBeenCalledTimes(1)
  const writes = fetch.mock.calls.filter(([, init]) => init?.method === 'POST')
  expect(writes).toHaveLength(1)
  expect(writes[0][0]).toBe(kind === 'bulk' ? '/api/v1/spools/bulk/status' : '/api/v1/spools/3/status')
  expect(JSON.parse(String(writes[0][1]!.body))).toEqual(kind === 'bulk' ? { spool_ids: [3], status: 'archived' } : { status: 'archived' })
  expect(writes[0][1]!.credentials).toBe('include')

  finish(Response.json({ success: true }))
  await request
  expect(modal.getAttribute('aria-busy')).toBe('false')
  expect([...modal.querySelectorAll('button')].every(button => !button.disabled)).toBe(true)
  expect(modal.open).toBe(kind === 'single')
  if (kind === 'bulk') expect(document.activeElement).toBe(opener)
  else expect(document.querySelector('#modal-content tbody tr')).toBeNull()
  await actions.openSpoolModal('problem')
  expect(modal.open).toBe(true)
})

it.each(['single', 'bulk'] as const)('restores the %s archive controls after a network failure or cancelled confirmation', async kind => {
  const fetch = await boot(true)
  const confirm = vi.fn(async () => false)
  const alert = vi.fn(async () => true)
  Object.assign(window, { __fmConfirm: confirm, __fmAlert: alert })
  const actions = window as unknown as DashboardActions
  await actions.openSpoolModal('problem')
  const archive = () => kind === 'bulk' ? actions.archiveAll([3]) : actions.archiveSpool(3)
  await archive()
  expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0)
  confirm.mockResolvedValue(true)
  fetch.mockRejectedValueOnce(new Error('Offline'))
  vi.spyOn(console, 'error').mockImplementation(() => {})
  await archive()
  expect(alert).toHaveBeenCalledWith('dashboard.archiveError')
  const modal = document.querySelector<HTMLDialogElement>('#spool-modal')!
  expect(modal.open).toBe(true)
  expect(modal.getAttribute('aria-busy')).toBe('false')
  expect([...modal.querySelectorAll('button')].every(button => !button.disabled)).toBe(true)
  expect(document.querySelector('#modal-content tbody tr')).not.toBeNull()
  expect(document.querySelector('#btn-archive-all')!.textContent).toBe('dashboard.archiveAll')
  await archive()
  expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(2)
  expect(alert).toHaveBeenCalledTimes(2)
  expect([...modal.querySelectorAll('button')].every(button => !button.disabled)).toBe(true)
})
