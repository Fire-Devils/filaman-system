// @vitest-environment happy-dom
import { bootAstroPage } from '../../tests/helpers/astro-page'
import { afterEach, expect, it, vi } from 'vitest'
import { bindFormDialog } from './form-dialog'
import { escapeHtml } from './extra-fields'
import { hasPermission } from './auth'
import * as layoutLib from './dashboard-layout'
import * as chartsLib from './dashboard-charts'
import * as widgetsLib from './dashboard-widgets'

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

const widgetFixtures: Record<string, unknown> = {
  '/dashboard/stale-spools?months=6': {
    months: 6, total_count: 2, total_weight_g: 1500, total_value: 38, unknown_value_count: 1,
    items: [
      { spool_id: 11, filament_designation: 'Old <PLA>', material_type: 'PLA', color_name: 'Red', colors: ['#FF0000'], manufacturer_name: 'Maker', remaining_weight_g: 500, remaining_value: 38, last_used_at: '2025-01-05T10:00:00Z' },
      { spool_id: 12, filament_designation: 'Never', material_type: 'PETG', color_name: null, colors: [], manufacturer_name: 'Maker', remaining_weight_g: 1000, remaining_value: null, last_used_at: null },
    ],
  },
  '/dashboard/stale-spools?months=12': { months: 12, items: [], total_count: 0, total_weight_g: 0, total_value: 0, unknown_value_count: 0 },
  '/dashboard/printer-slots': {
    printers: [{ printer_id: 1, printer_name: 'Alpha <X1>', slots: [
      { slot_no: 1, name: 'AMS A1', spool_id: 21, filament_designation: 'Silk', material_type: 'PLA', color_name: null, colors: ['#112233', '#445566'], manufacturer_name: 'Maker', remaining_weight_g: 640 },
      { slot_no: 2, name: null, spool_id: null, filament_designation: null, material_type: null, color_name: null, colors: [], manufacturer_name: null, remaining_weight_g: null },
    ] }],
  },
  '/spools/all-events?page=1&page_size=10&sort_by=event_at&sort_order=desc': {
    total: 2, page: 1, page_size: 10, items: [
      { id: 2, spool_id: 5, event_type: 'print_consumption', event_at: new Date().toISOString(), colors: [{ name: 'Red', hex_code: '#ff0000' }], measured_weight_g: null, delta_weight_g: -12.34 },
      { id: 1, spool_id: null, event_type: 'spool_deleted', event_at: new Date(Date.now() - 7200000).toISOString(), colors: [], measured_weight_g: null, delta_weight_g: null },
    ],
  },
  '/dashboard/top-consumers?days=90&limit=8': {
    days: 90, items: [
      { filament_id: 3, filament_designation: 'Black', material_type: 'PLA', color_name: 'Jet', colors: ['#000000'], manufacturer_name: 'Maker', consumed_g: 2000, spools_in_stock: 2 },
      { filament_id: 4, filament_designation: 'White', material_type: 'PETG', color_name: null, colors: ['#FFFFFF'], manufacturer_name: 'Maker', consumed_g: 500, spools_in_stock: 0 },
    ],
  },
  '/dashboard/stock-range?days=90': {
    days: 90, items: [
      { material_type: 'PLA', remaining_g: 200, consumed_g: 900, days_left: 20 },
      { material_type: 'PETG', remaining_g: 1000, consumed_g: 90, days_left: 1000 },
      { material_type: 'ASA', remaining_g: 800, consumed_g: 0, days_left: null },
    ],
  },
}

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
      : path.startsWith('/dashboard/history') ? { months: historyMonths }
      : path in widgetFixtures ? widgetFixtures[path] : prefs),
    patch: vi.fn(async (_path: string, _body: unknown) => {}),
  }
  const dependencies = {
    ...layoutLib, ...chartsLib, ...widgetsLib,
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
  expect(document.querySelectorAll('#dashboard-widgets > [data-widget]').length).toBe(18)
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
  expect(firstFour.length).toBe(18)
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
  // spoolStatus is hidden here, so it sorts behind the visible cards while arranging.
  expect(order.slice(0, 3)).toEqual(['locationStats', 'filamentStats', 'lowStockSpools'])
  expect(order.at(-1)).toBe('spoolStatus')

  const reset = [...document.querySelectorAll<HTMLButtonElement>('#widget-menu-list button')].find(b => b.textContent === 'dashboard.resetWidgets')!
  reset.click()
  expect(fetch.api.patch).toHaveBeenLastCalledWith('/me/preferences', { dashboard_hidden_widgets: [], dashboard_widget_order: [], dashboard_layout: 'grid' })
  expect(document.querySelector('#dashboard-widgets')!.classList.contains('is-editing')).toBe(false)
  expect(document.querySelector<HTMLElement>('#dashboard-widgets > [data-widget]')!.dataset.widget).toBe('spoolStatus')
})

it('eye button hides a card, keeps it dimmed at the end while arranging and shows it again', async () => {
  const fetch = await boot(false, undefined, undefined, undefined, undefined, {
    dashboard_hidden_widgets: ['spoolStatus'], dashboard_widget_order: ['spoolStatus', 'locationStats'],
  })
  const card = (id: string) => document.querySelector<HTMLElement>(`[data-widget="${id}"]`)!
  const eye = (id: string) => card(id).querySelector<HTMLButtonElement>('.dashboard-eye-btn')!
  // Outside arrange mode a hidden card stays invisible.
  expect(card('spoolStatus').style.display).toBe('none')

  document.querySelector<HTMLButtonElement>('#widget-arrange-btn')!.click()
  expect(card('spoolStatus').style.display).toBe('')
  expect(card('spoolStatus').classList.contains('is-widget-hidden')).toBe(true)
  const area = document.querySelector<HTMLElement>('#dashboard-hidden-widgets')!
  expect(area.classList.contains('hidden')).toBe(false)
  expect(area.contains(card('spoolStatus'))).toBe(true)
  expect(document.querySelector('#dashboard-widgets')!.contains(card('spoolStatus'))).toBe(false)

  eye('locationStats').click()
  expect(fetch.api.patch).toHaveBeenLastCalledWith('/me/preferences', { dashboard_hidden_widgets: ['spoolStatus', 'locationStats'] })
  expect(card('locationStats').classList.contains('is-widget-hidden')).toBe(true)
  expect(document.querySelector<HTMLInputElement>('#widget-menu-list input[data-widget-id="locationStats"]')!.checked).toBe(false)

  eye('spoolStatus').click()
  const calls = fetch.api.patch.mock.calls.slice(-2).map(c => c[1] as Record<string, string[]>)
  expect(calls[0]).toEqual({ dashboard_hidden_widgets: ['locationStats'] })
  const order = calls[1].dashboard_widget_order
  expect(order.indexOf('spoolStatus')).toBe(order.length - 2)
  expect(order.at(-1)).toBe('locationStats')
  expect(card('spoolStatus').classList.contains('is-widget-hidden')).toBe(false)
  expect(document.querySelector('#dashboard-widgets')!.contains(card('spoolStatus'))).toBe(true)
  expect(area.contains(card('locationStats'))).toBe(true)

  document.querySelector<HTMLButtonElement>('#widget-edit-done')!.click()
  expect(card('locationStats').style.display).toBe('none')
  expect(area.classList.contains('hidden')).toBe(true)
  expect(document.querySelector('#dashboard-widgets')!.contains(card('locationStats'))).toBe(true)
})

it('loads chart data when an eye button shows a hidden chart again', async () => {
  const hiddenCharts = ['chartSpend', 'chartConsumption', 'chartStockValue', 'chartSpoolCount', 'chartTotalWeight']
  const fetch = await boot(false, undefined, undefined, undefined, undefined, { dashboard_hidden_widgets: hiddenCharts })
  await new Promise(resolve => setTimeout(resolve, 0))
  document.querySelector<HTMLButtonElement>('#widget-arrange-btn')!.click()
  document.querySelector<HTMLButtonElement>('[data-widget="chartSpend"] .dashboard-eye-btn')!.click()
  await vi.waitFor(() => expect(document.querySelector('#chart-spend svg')).not.toBeNull())
  expect(fetch.api.get).toHaveBeenCalledWith('/dashboard/history?months=12')
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

it('shows the recording hint instead of an empty stock chart while no snapshot exists', async () => {
  const saved = historyMonths.map(month => ({ ...month }))
  historyMonths.forEach(month => Object.assign(month, { spool_count: null, total_weight_g: null, stock_value: null }))
  try {
    await boot(false, undefined, undefined, undefined, undefined, { dashboard_hidden_widgets: [] })
    await vi.waitFor(() => expect(document.querySelector('#chart-spend svg')).not.toBeNull())
    for (const id of ['chart-stock-value', 'chart-spool-count', 'chart-total-weight']) {
      expect(document.querySelector(`#${id}`)!.textContent).toBe('dashboard.chartNoSnapshots')
    }
    expect(document.querySelector('#chart-spend p')).toBeNull()
  } finally {
    historyMonths.forEach((month, i) => Object.assign(month, saved[i]))
  }
})

const dataCards = ['staleSpools', 'printerSlots', 'recentActivity', 'topConsumers', 'stockRange']
const dataPaths = Object.keys(widgetFixtures).filter(path => path !== '/dashboard/stale-spools?months=12')

it('renders the five data cards from their endpoints', async () => {
  const fetch = await boot()
  await vi.waitFor(() => expect(document.querySelector('#stock-range tbody tr')).not.toBeNull())
  for (const path of dataPaths) expect(fetch.api.get).toHaveBeenCalledWith(path)
  for (const id of dataCards) expect(document.querySelectorAll(`#dashboard-widgets > [data-widget="${id}"]`)).toHaveLength(1)

  const stale = document.querySelector('#stale-spools')!
  expect(stale.querySelectorAll('tbody tr')).toHaveLength(2)
  expect(stale.querySelector('a')!.getAttribute('href')).toBe('/spools/11')
  expect(stale.textContent).toContain('Old <PLA> (Red)')
  expect(stale.querySelector('img')).toBeNull()
  expect(stale.querySelectorAll('tbody tr')[1].textContent).toContain('dashboard.staleNever')
  expect(stale.querySelector('tfoot')!.textContent).toContain('1.5 kg')
  expect(stale.querySelector('tfoot')!.textContent).toContain('€38')
  expect(stale.querySelectorAll('.dash-dot')[0].getAttribute('style')).toBe('background:#FF0000')
  expect(stale.querySelectorAll('.dash-dot')[1].classList.contains('is-empty')).toBe(true)

  const slots = document.querySelector('#printer-slots')!
  expect(slots.querySelector('.dash-group')!.textContent).toBe('Alpha <X1>')
  expect(slots.querySelector('a')!.getAttribute('href')).toBe('/spools/21')
  expect(slots.textContent).toContain('dashboard.slotEmpty')
  expect(slots.textContent).toContain('640 g')

  const activity = document.querySelector('#recent-activity')!
  const rows = activity.querySelectorAll('tbody tr')
  expect(rows[0].querySelector('a')!.getAttribute('href')).toBe('/spools/5')
  expect(rows[0].textContent).toContain('-12.3 g')
  expect(rows[1].textContent).toContain('spoolLog.deletedSpool')
  expect(rows[1].querySelector('.fm-pill')!.textContent).toBe('spool_deleted')
  for (const id of ['stale-spools', 'recent-activity', 'stock-range', 'printer-slots', 'top-consumers']) {
    expect(document.querySelectorAll(`#${id} thead th`).length).toBeLessThanOrEqual(4)
  }
  expect(rows[1].querySelector('.fm-pill')!.getAttribute('style')).toContain('--error-text')
  expect(activity.querySelector('a[href="/spool-log"]')).not.toBeNull()

  const top = document.querySelector('#top-consumers')!
  expect(top.querySelector('a')!.getAttribute('href')).toBe('/filaments/3')
  expect([...top.querySelectorAll('.dash-bar > span')].map(bar => bar.getAttribute('style'))).toEqual(['width:100%', 'width:25%'])

  const range = [...document.querySelectorAll('#stock-range tbody tr')].map(row => [...row.querySelectorAll('td')].map(cell => cell.textContent))
  expect(range).toEqual([
    ['PLA', '200 gdashboard.rangeConsumed', 'dashboard.rangeWeeks'],
    ['PETG', '1.0 kgdashboard.rangeConsumed', 'dashboard.rangeOverYear'],
    ['ASA', '800 gdashboard.rangeConsumed', 'dashboard.rangeNone'],
  ])
  expect(document.querySelector('#stock-range tbody tr td:last-child')!.classList.contains('is-critical')).toBe(true)
  expect(document.querySelectorAll('#stock-range .is-critical')).toHaveLength(1)
  expect(document.querySelector('[data-widget="stockRange"] .dashboard-widget-note')!.getAttribute('data-i18n')).toBe('dashboard.rangeNote')
})

it('switches the dead stock threshold and remembers it', async () => {
  const fetch = await boot()
  await vi.waitFor(() => expect(document.querySelector('#stale-spools tbody tr')).not.toBeNull())
  expect(document.querySelector('[data-stale-range] .active')!.textContent).toBe('dashboard.staleMonths')
  const pills = document.querySelectorAll<HTMLButtonElement>('[data-stale-range] button')
  expect(pills).toHaveLength(3)
  pills[2].click()
  await vi.waitFor(() => expect(document.querySelector('#stale-spools tbody')).toBeNull())
  expect(fetch.api.get).toHaveBeenCalledWith('/dashboard/stale-spools?months=12')
  expect(localStorage.getItem('dashboard-stale-months')).toBe('12')
  expect(document.querySelector('#stale-spools')!.textContent).toBe('dashboard.staleEmpty')
})

it('loads a data card only while it is visible and when it is shown again', async () => {
  const fetch = await boot(false, undefined, undefined, undefined, undefined, { dashboard_hidden_widgets: dataCards })
  await new Promise(resolve => setTimeout(resolve, 0))
  const requested = () => fetch.api.get.mock.calls.map(([path]) => path)
  for (const path of dataPaths) expect(requested()).not.toContain(path)
  document.querySelector<HTMLButtonElement>('#widget-arrange-btn')!.click()
  document.querySelector<HTMLButtonElement>('[data-widget="topConsumers"] .dashboard-eye-btn')!.click()
  await vi.waitFor(() => expect(document.querySelector('#top-consumers tbody tr')).not.toBeNull())
  expect(requested()).toContain('/dashboard/top-consumers?days=90&limit=8')
  expect(requested()).not.toContain('/dashboard/stock-range?days=90')
})

it('reloads the data cards on spool changes', async () => {
  const fetch = await boot()
  await vi.waitFor(() => expect(document.querySelector('#stock-range tbody tr')).not.toBeNull())
  const count = () => fetch.api.get.mock.calls.filter(([path]) => path === '/dashboard/stock-range?days=90').length
  expect(count()).toBe(1)
  window.dispatchEvent(new CustomEvent('filaman:data-changed', { detail: { event: 'spools_changed' } }))
  await vi.waitFor(() => expect(count()).toBe(2))
})

it('links to the printers when there are none and keeps loaded data when a reload fails', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  const saved = widgetFixtures['/dashboard/printer-slots']
  widgetFixtures['/dashboard/printer-slots'] = { printers: [] }
  try {
    await boot()
    await vi.waitFor(() => expect(document.querySelector('#printer-slots a')).not.toBeNull())
    expect(document.querySelector('#printer-slots a')!.getAttribute('href')).toBe('/printers')
  } finally {
    widgetFixtures['/dashboard/printer-slots'] = saved
  }
  document.body.replaceChildren()
  const fetch = await boot()
  await vi.waitFor(() => expect(document.querySelector('#top-consumers tbody tr')).not.toBeNull())
  fetch.api.get.mockImplementation(async () => { throw new Error('boom') })
  window.dispatchEvent(new CustomEvent('filaman:data-changed', { detail: { event: 'spools_changed' } }))
  await vi.waitFor(() => expect(error).toHaveBeenCalled())
  expect(document.querySelector('#top-consumers tbody tr')).not.toBeNull()
})

it('shows an error text when the first load of a card fails', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const fetch = await boot(false, undefined, undefined, undefined, undefined, { dashboard_hidden_widgets: ['topConsumers'] })
  fetch.api.get.mockImplementation(async () => { throw new Error('boom') })
  document.querySelector<HTMLButtonElement>('#widget-arrange-btn')!.click()
  document.querySelector<HTMLButtonElement>('[data-widget="topConsumers"] .dashboard-eye-btn')!.click()
  await vi.waitFor(() => expect(document.querySelector('#top-consumers')!.textContent).toBe('dashboard.widgetLoadError'))
})
