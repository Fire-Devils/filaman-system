// @vitest-environment happy-dom
import { bootAstroPage } from '../../tests/helpers/astro-page'
import { afterEach, expect, it, vi } from 'vitest'
import { bindFormDialog } from './form-dialog'
import { escapeHtml } from './extra-fields'
import { hasPermission } from './auth'
import * as layoutLib from './dashboard-layout'
import * as chartsLib from './dashboard-charts'

async function openDrilldown() {
  document.querySelector<HTMLButtonElement>('#problem-spools')!.click()
  await vi.waitFor(() => expect(document.querySelector('#modal-content a')).not.toBeNull())
}

function archiveButton(kind: 'single' | 'bulk') {
  return document.querySelector<HTMLButtonElement>(kind === 'bulk' ? '#btn-archive-all' : '#modal-content [data-archive-spool]')!
}

const historyMonths = [
  { month: '2026-01', spend: 10, consumption_g: 0, spool_count: 1, total_weight_g: 1000, stock_value: 20 },
  { month: '2026-02', spend: 0, consumption_g: 250, spool_count: 2, total_weight_g: 1750, stock_value: 30 },
]

async function boot(canArchive = false, poll = async () => Response.json([
  { location_id: 9, location_name: "Dry <box>", spool_count: 5, total_weight_g: 3000 },
]), summaryReady?: Promise<void>, currencyReady?: Promise<void>, valuation: { remaining_value: number | null; unknown_spool_count: number } = { remaining_value: 1.2, unknown_spool_count: 0 }, prefs: Record<string, unknown> = { dashboard_hidden_widgets: [] }) {
  const fetch = vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/v1/dashboard/locations') return poll()
    if (init?.method) return Response.json({ detail: 'Not permitted' }, { status: 403 })
    await summaryReady
    return Response.json({
      spool_count_total: 1, filament_count_total: 2, filament_count_active: 1, filament_count_used: 0,
      spool_distribution: { full: 0, normal: 0, low: 1, critical: 0, empty: 0 }, total_value_available: 3, valuation,
      manufacturers_with_spools: [{ id: 7, name: 'Maker <clear>', spool_count: 2 }],
      low_stock_spools: [{ spool_id: 3, filament_designation: 'Sample', filament_type: 'PLA', manufacturer_name: 'Maker', remaining_weight_g: 50 }],
      low_stock_filaments: [{ filament_id: 5, filament_designation: 'Black <PETG>', filament_type: 'PETG', manufacturer_name: 'Maker', total_remaining_g: 600, low_stock_threshold_g: 700, spool_count: 2 }],
      filament_types: [{ material_type: 'Empty-only type', count: 4 }],
      location_stats: [{ location_id: 9, location_name: 'Dry <box>', spool_count: 4, total_weight_g: 2500 }],
      filament_stats: [{ filament_type: 'PLA', spool_count: 2, total_weight_g: 1500 }, { filament_type: 'PETG <clear>', spool_count: 1, total_weight_g: 250 }],
    })
  })
  const fetchAllPages = vi.fn(async (_path: string) => ({
    items: [{ id: 3, remaining_weight_g: 50, filament: { designation: '<img src=x onerror=alert(1)>', material_type: 'PLA' } }],
    total: 1,
  }))
  const api = {
    get: vi.fn(async (path: string) => path === '/me'
      ? { is_superadmin: false, permissions: canArchive ? ['spool_events:create_status'] : [] }
      : path.startsWith('/dashboard/history') ? { months: historyMonths } : prefs),
    patch: vi.fn(async (_path: string, _body: unknown) => {}),
  }
  const dependencies = {
    ...layoutLib, ...chartsLib,
    t: (key: string) => key, initI18n: async () => {}, getLang: () => 'en',
    formatPrice: (value: number) => `€${value}`, getCurrency: () => 'EUR', initCurrency: async () => currencyReady,
    VERSION: '', changelogData: { versions: [] },
    fetchAllPages, getAbortSignal: () => undefined,
    isAbortError: () => false,
    hasPermission,
    mountSpoolLinkBanner: async () => ({ refresh: async () => {} }),
    bindFormDialog, escapeHtml, fetch,
    api,
  }
  await bootAstroPage('index', dependencies)
  if (!summaryReady) await vi.waitFor(() => expect(document.querySelector('#stat-total-spools')!.textContent).toBe('1'))
  return Object.assign(fetch, { fetchAllPages, api })
}
afterEach(() => {
  window.dispatchEvent(new Event("pagehide"))
  vi.useRealTimers()
  vi.restoreAllMocks()
  document.body.replaceChildren()
  localStorage.clear()
})

it('renders safe material statistics and scope controls, and opens a read-only drilldown without archive permission', async () => {
  await boot()
  expect(document.querySelector('#filament-types')).toBeNull()
  const rows = [...document.querySelectorAll('#filament-stats tbody tr')]
  expect(rows.map(row => [...row.querySelectorAll('td')].map(cell => cell.textContent)))
    .toEqual([['PLA', '2', '1.5 kg'], ['PETG <clear>', '1', '250 g']])
  expect(rows[1].querySelector('a')!.getAttribute('href')).toBe('/spools?material=PETG%20%3Cclear%3E')
  expect(document.querySelector('#filament-stats')!.textContent).not.toContain('Empty-only type')
  const lowFilament = document.querySelector('#low-stock-filaments tbody tr')!
  expect(lowFilament.querySelector('a')!.getAttribute('href')).toBe('/filaments/5')
  expect(lowFilament.textContent).toContain('Black <PETG> (PETG)')
  expect(lowFilament.textContent).toContain('600 / 700g')
  expect(document.querySelector('#low-stock-filaments img')).toBeNull()

  document.querySelector<HTMLButtonElement>('[data-scope="active"]')!.click()
  expect(document.querySelector('#stat-total-filaments')!.textContent).toBe('1')
  expect(document.querySelector('[data-scope="active"]')!.getAttribute('aria-pressed')).toBe('true')
  const opener = document.querySelector<HTMLButtonElement>('#problem-spools')!
  opener.focus()
  opener.click()
  await vi.waitFor(() => expect(document.querySelector('#modal-content a')).not.toBeNull())
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
  await openDrilldown()
  archiveButton('single').click()
  await vi.waitFor(() => expect(archiveButton('single').disabled).toBe(false))
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
  const opener = document.querySelector<HTMLButtonElement>('#problem-spools')!
  opener.focus()
  await openDrilldown()
  const modal = document.querySelector<HTMLDialogElement>('#spool-modal')!
  const row = document.querySelector('#modal-content tbody tr')!
  let finish!: (response: Response) => void
  fetch.mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve }))
  archiveButton(kind).click()
  archiveButton('bulk').click()
  archiveButton('single').click()
  expect(confirm).toHaveBeenCalledTimes(1)
  expect(modal.getAttribute('aria-busy')).toBe('true')
  confirmArchive(true)
  await vi.waitFor(() => expect(fetch.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true))

  modal.dispatchEvent(new Event('cancel', { cancelable: true }))
  expect(modal.open).toBe(true)
  modal.click()
  document.querySelector<HTMLButtonElement>('#spool-modal [data-dialog-close]')!.click()
  opener.click()
  archiveButton('bulk').click()
  archiveButton('single').click()
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
  await vi.waitFor(() => expect(modal.getAttribute('aria-busy')).toBe('false'))
  expect(modal.getAttribute('aria-busy')).toBe('false')
  expect([...modal.querySelectorAll('button')].every(button => !button.disabled)).toBe(true)
  expect(modal.open).toBe(kind === 'single')
  if (kind === 'bulk') expect(document.activeElement).toBe(opener)
  else {
    expect(document.querySelector('#modal-content tbody tr')).toBeNull()
    modal.querySelector<HTMLButtonElement>('[data-dialog-close]')!.click()
  }
  await openDrilldown()
  expect(modal.open).toBe(true)
})

it.each(['single', 'bulk'] as const)('restores the %s archive controls after a network failure or cancelled confirmation', async kind => {
  const fetch = await boot(true)
  const confirm = vi.fn(async () => false)
  const alert = vi.fn(async () => true)
  Object.assign(window, { __fmConfirm: confirm, __fmAlert: alert })
  await openDrilldown()
  async function archive() {
    archiveButton(kind).click()
    await vi.waitFor(() => expect(archiveButton(kind).disabled).toBe(false))
  }
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


it("refreshes just the enabled Locations widget every 15 seconds on a visible tab", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] })
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible")
  const fetch = await boot()
  fetch.mockClear()
  await vi.advanceTimersByTimeAsync(14000)
  expect(fetch).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1000)
  expect(fetch.mock.calls.map(([path]) => path)).toEqual(["/api/v1/dashboard/locations"])
  expect(document.querySelector("#location-stats")!.textContent).toContain("5 dashboard.spools")

  visibility.mockReturnValue("hidden")
  await vi.advanceTimersByTimeAsync(15000)
  expect(fetch).toHaveBeenCalledTimes(1)
  visibility.mockReturnValue("visible")
  document.dispatchEvent(new Event("visibilitychange"))
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))

  document.querySelector<HTMLInputElement>('[data-widget-id="locationStats"]')!.click()
  await vi.advanceTimersByTimeAsync(15000)
  expect(fetch).toHaveBeenCalledTimes(2)
})


it("keeps one location poll in flight and preserves focus when the counts change", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] })
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible")
  let resolvePoll!: (response: Response) => void
  const fetch = await boot(false, () => new Promise<Response>(resolve => { resolvePoll = resolve }))
  fetch.mockClear()
  document.querySelector<HTMLAnchorElement>("#location-stats a")!.focus()
  await vi.advanceTimersByTimeAsync(30000)
  expect(fetch).toHaveBeenCalledTimes(1)

  resolvePoll(Response.json([
    { location_id: 9, location_name: "Dry <box>", spool_count: 6, total_weight_g: 3500 },
  ]))
  await vi.waitFor(() => expect(document.querySelector("#location-stats")!.textContent).toContain("6 dashboard.spools"))
  expect(document.activeElement).toBe(document.querySelector("#location-stats a"))
  window.dispatchEvent(new Event("pagehide"))
  await vi.advanceTimersByTimeAsync(15000)
  expect(fetch).toHaveBeenCalledTimes(1)
})

it("refreshes Locations independently of the initial summary request", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] })
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible")
  const fetch = await boot(false, undefined, new Promise(() => {}))

  await vi.advanceTimersByTimeAsync(15000)
  expect(fetch.mock.calls.map(([path]) => path)).toEqual(["/api/v1/dashboard/stats?limit=20&include_totals=true&include_valuation=true", "/api/v1/dashboard/locations"])
  expect(document.querySelector("#location-stats")!.textContent).toContain("5 dashboard.spools")
})

it('loads summary counts on entry and fetches fresh problem spools only when the dialog opens', async () => {
  let setCurrency!: () => void
  const fetch = await boot(false, undefined, undefined, new Promise(resolve => { setCurrency = resolve }))
  expect(fetch.mock.calls.map(([path]) => path)).toEqual(['/api/v1/dashboard/stats?limit=20&include_totals=true&include_valuation=true'])
  expect(document.querySelector('#stat-total-filaments')!.textContent).toBe('2')
  expect(document.querySelector('#stat-total-value')!.textContent).toBe('—')
  setCurrency()
  await vi.waitFor(() => expect(document.querySelector('#stat-total-value')!.textContent).toBe('€3'))
  expect(document.querySelector('#stat-remaining-value')!.textContent).toBe('€1.2')
  expect(document.querySelector('#stat-total-value')!.textContent).toBe('€3')
  expect(document.querySelector('#stat-remaining-value-box')!.getAttribute('title')).toBe('dashboard.remainingValueHint')
  expect(fetch.fetchAllPages).not.toHaveBeenCalled()
  fetch.fetchAllPages.mockRejectedValueOnce(new Error('Offline'))
  document.querySelector<HTMLButtonElement>('#problem-spools')!.click()
  await vi.waitFor(() => expect(document.querySelector('#modal-content')!.textContent).toContain('spools.failedLoad'))
  document.querySelector<HTMLButtonElement>('#spool-modal [data-dialog-close]')!.click()
  await openDrilldown()
  expect(fetch.fetchAllPages.mock.calls.map(([path]) => path)).toEqual(Array(2).fill('/api/v1/spools?low_or_empty=true'))
  expect(document.querySelector('#modal-content a')?.getAttribute('href')).toBe('/spools/3')
})

it('ignores an older drilldown response after closing and reopening the dialog', async () => {
  const fetch = await boot()
  let finish!: (value: Awaited<ReturnType<typeof fetch.fetchAllPages>>) => void
  fetch.fetchAllPages.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const opener = document.querySelector<HTMLButtonElement>('#problem-spools')!
  opener.click()
  document.querySelector<HTMLButtonElement>('#spool-modal [data-dialog-close]')!.click()
  await openDrilldown()
  finish({ items: [], total: 0 })
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(document.querySelector('#modal-content a')?.getAttribute('href')).toBe('/spools/3')
})


it('shows an unknown total instead of zero when every spool lacks a valuation', async () => {
  await boot(false, undefined, undefined, undefined, { remaining_value: null, unknown_spool_count: 1 })
  await vi.waitFor(() => expect(document.querySelector('#stat-remaining-value-box')!.getAttribute('title')).toBe('dashboard.remainingValueHint\ninventoryValue.incomplete'))
  expect(document.querySelector('#stat-remaining-value')!.textContent).toBe('—')
  expect(document.querySelector('#stat-total-value')!.textContent).toBe('€3')
})

it('applies the saved widget order, hides widgets and keeps unknown widgets at the end', async () => {
  await boot(false, undefined, undefined, undefined, undefined, {
    dashboard_hidden_widgets: ['spoolStatus'],
    dashboard_widget_order: ['filamentStats', 'ghostWidget', 'locationStats'],
    dashboard_layout: 'grid',
  })
  const ids = [...document.querySelectorAll<HTMLElement>('#dashboard-widgets > [data-widget]')].map(card => card.dataset.widget)
  expect(ids.slice(0, 2)).toEqual(['filamentStats', 'locationStats'])
  expect(ids).not.toContain('ghostWidget')
  expect(ids.slice(2, 5)).toEqual(['spoolStatus', 'lowStockSpools', 'lowStockFilaments'])
  expect(document.querySelector<HTMLElement>('[data-widget="spoolStatus"]')!.style.display).toBe('none')
  expect(document.querySelectorAll('#dashboard-widgets > [data-widget]').length).toBe(12)
})

it('distributes widgets over masonry columns by height and keeps left-to-right order', async () => {
  const heights: Record<string, number> = { spoolStatus: 100, locationStats: 300, lowStockSpools: 100, lowStockFilaments: 100 }
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return heights[this.dataset.widget ?? ''] ?? 50
  })
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(700)
  await boot(false, undefined, undefined, undefined, undefined, { dashboard_hidden_widgets: [], dashboard_layout: 'masonry' })
  const columns = [...document.querySelectorAll('#dashboard-widgets > .dashboard-masonry-col')]
  expect(document.querySelector('#dashboard-widgets')!.classList.contains('is-masonry')).toBe(true)
  expect(columns.length).toBe(2)
  const firstFour = [...document.querySelectorAll<HTMLElement>('[data-widget]')]
  const column = (id: string) => columns.findIndex(col => col.contains(document.querySelector(`[data-widget="${id}"]`)))
  // 100 -> left, 300 -> right, then the next two stack into the shorter left column.
  expect([column('spoolStatus'), column('locationStats'), column('lowStockSpools'), column('lowStockFilaments')]).toEqual([0, 1, 0, 0])
  expect(firstFour.length).toBe(12)
})

it('saves order and layout through the menu and resets all three together', async () => {
  const fetch = await boot(false, undefined, undefined, undefined, undefined, {
    dashboard_hidden_widgets: ['spoolStatus'], dashboard_widget_order: ['filamentStats'], dashboard_layout: 'masonry',
  })
  const radio = document.querySelector<HTMLInputElement>('input[name="dashboard-layout"][value="grid"]')!
  radio.checked = true
  radio.dispatchEvent(new Event('change'))
  expect(fetch.api.patch).toHaveBeenLastCalledWith('/me/preferences', { dashboard_layout: 'grid' })
  expect(document.querySelector('#dashboard-widgets')!.classList.contains('is-masonry')).toBe(false)

  document.querySelector<HTMLButtonElement>('#widget-arrange-btn')!.click()
  expect(document.querySelector('#dashboard-widgets')!.classList.contains('is-editing')).toBe(true)
  expect(document.querySelector('#widget-edit-done')!.classList.contains('hidden')).toBe(false)
  const handle = document.querySelector<HTMLButtonElement>('[data-widget="filamentStats"] .dashboard-drag-handle')!
  handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
  const order = (fetch.api.patch.mock.calls.at(-1)![1] as { dashboard_widget_order: string[] }).dashboard_widget_order
  expect(order.slice(0, 3)).toEqual(['spoolStatus', 'locationStats', 'filamentStats'])

  const reset = [...document.querySelectorAll<HTMLButtonElement>('#widget-menu-list button')].find(b => b.textContent === 'dashboard.resetWidgets')!
  reset.click()
  expect(fetch.api.patch).toHaveBeenLastCalledWith('/me/preferences', { dashboard_hidden_widgets: [], dashboard_widget_order: [], dashboard_layout: 'grid' })
  expect(document.querySelector('#dashboard-widgets')!.classList.contains('is-editing')).toBe(false)
  expect(document.querySelector<HTMLElement>('#dashboard-widgets > [data-widget]')!.dataset.widget).toBe('spoolStatus')
})

it('loads history only while a chart is visible and draws chart widgets', async () => {
  const hiddenCharts = ['chartSpend', 'chartConsumption', 'chartStockValue', 'chartSpoolCount', 'chartTotalWeight']
  const none = await boot(false, undefined, undefined, undefined, undefined, { dashboard_hidden_widgets: hiddenCharts })
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(none.api.get.mock.calls.map(([path]) => path).filter(path => path.startsWith('/dashboard/history'))).toEqual([])
  document.body.replaceChildren()

  const some = await boot(false, undefined, undefined, undefined, undefined, { dashboard_hidden_widgets: hiddenCharts.slice(1) })
  await vi.waitFor(() => expect(document.querySelector('#chart-spend svg')).not.toBeNull())
  expect(some.api.get).toHaveBeenCalledWith('/dashboard/history?months=12')
  expect(document.querySelectorAll('#chart-spend rect[fill="var(--accent)"]').length).toBe(2)
  expect(document.querySelector('#chart-spend title')!.textContent).toContain('dashboard.chartMonthTip')
  expect(document.querySelector('#chart-spend')!.closest('[data-widget]')!.querySelectorAll('[data-chart-range] button').length).toBe(3)
})
