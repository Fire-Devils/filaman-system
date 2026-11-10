// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { clearState, mockHttp, pageFixture, type Transport } from './detail-page-test-support'

let page: Awaited<ReturnType<typeof pageFixture>> | undefined

beforeEach(() => {
  clearState()
  vi.useFakeTimers()
})

afterEach(() => {
  page?.dispose()
  page = undefined
  document.body.replaceChildren()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function slotDots() {
  return [...document.querySelectorAll<HTMLElement>('#printer-slots-inline .slot-dot')]
}

async function setup(options: {
  slots: Record<string, unknown>[]
  dbSlots?: Record<string, unknown>[]
  name?: string
  driverKey?: string
  activeSpoolOnRefresh?: number
  activeSpoolId?: number
  connectedOnRefresh?: boolean
  intercept?: Transport
}) {
  const printer = { id: 1, name: options.name ?? 'Printer', driver_key: options.driverKey ?? 'bambulab', is_active: true }
  const http = mockHttp({ printers: [printer], intercept(path, init) {
    const override = options.intercept?.(path, init)
    if (override) return override
    const { pathname, searchParams } = new URL(path, 'http://localhost')
    if (pathname === '/api/v1/printers/1/driver/health') {
      const refreshing = searchParams.has('refresh')
      return Response.json({
        connected: refreshing ? options.connectedOnRefresh ?? true : true,
        driver_key: printer.driver_key,
        slots: options.slots,
        active_spool_id: refreshing ? options.activeSpoolOnRefresh : options.activeSpoolId,
      })
    }
    if (pathname === '/api/v1/printers/1/slots') return Response.json(options.dbSlots ?? [])
    if (pathname === '/api/v1/printers/1/driver/action') return Response.json({ success: true })
    if (pathname.endsWith('/connected-models') || pathname.endsWith('/profile-coverage')) return Response.json({})
  } })
  page = await pageFixture('spool')
  await vi.advanceTimersByTimeAsync(200)
  if (options.connectedOnRefresh !== false) expect(slotDots()).toHaveLength(options.slots.length)
  return http
}

function clickAssign(dot: HTMLElement) {
  dot.click()
  document.querySelector<HTMLElement>('[data-action="assign"]')!.click()
}

async function assign(dot: HTMLElement) {
  clickAssign(dot)
  await vi.advanceTimersByTimeAsync(0)
  expect(dot.classList.contains('slot-sending')).toBe(true)
}

it('shows occupied bays with missing or placeholder color separately from empty bays', async () => {
  await setup({
    slots: [
      { slot_index: '0-0', present: true },
      { slot_index: '0-1', present: true, tray_color: '00000000' },
      { slot_index: '0-2', present: false, tray_color: '112233' },
      { slot_index: '0-3', tray_type: 'PETG', tray_color: '#123456FF' },
      { slot_index: '1-0', present: true, tray_color: '00000000', spool_id: null },
    ],
    dbSlots: [
      { slot_no: 2, assignment: { present: true, spool_id: 42, color_hex: '#112233' } },
      { slot_no: 4, assignment: { present: true, spool_id: 42, color_hex: '#112233' } },
    ],
  })
  const [occupied, placeholder, empty, legacy, unlinked] = slotDots()
  expect(occupied.title).toBe('Occupied')
  expect(placeholder.title).toBe('Occupied')
  expect(placeholder.getAttribute('style')).toBe(occupied.getAttribute('style'))
  expect(occupied.textContent).toBe('')
  expect(placeholder.textContent).toBe('')
  expect(empty.title).toBe('Empty')
  expect(empty.textContent).toBe('✕')
  expect(legacy.title).toBe('PETG')
  expect(legacy.getAttribute('style')).toContain('background:#123456;')
  expect(unlinked.title).toBe('Occupied')
  expect(unlinked.getAttribute('style')).toBe(occupied.getAttribute('style'))
})

it('joins external tray metadata by canonical key and sends the raw tray ID', async () => {
  const options = {
    slots: [
      { slot_index: '255-254', present: true, spool_id: 31 },
      { slot_index: '255-255', present: true, spool_id: 32 },
    ],
    dbSlots: [
      { custom_fields: { slot_index: '255-0' }, assignment: { spool_id: 31, color_hex: '#123456' } },
      { slot_no: 1001, assignment: { spool_id: 32, color_hex: '#654321' } },
      { custom_fields: { slot_index: '255-254' }, is_active: false, assignment: { spool_id: 99 } },
      { custom_fields: { slot_index: '255-255' }, is_active: true, assignment: { spool_id: 98 } },
    ],
  }
  const http = await setup(options)
  const [first, second] = slotDots()
  expect(first.title).toBe('(#31)')
  expect(second.title).toBe('(#32)')
  expect(first.getAttribute('style')).toContain('background:#123456;')
  expect(second.getAttribute('style')).toContain('background:#654321;')
  await assign(first)
  expect(http.calls.find(call => call.method === 'POST')?.body).toMatchObject({
    action: 'send_filament_to_tray', params: { ams_id: 255, tray_id: 254, spool_id: '17' },
  })
  options.slots[0] = { slot_index: '255-0', present: true, spool_id: 17 }
  await vi.advanceTimersByTimeAsync(3000)
  expect(first.classList.contains('slot-success')).toBe(true)
})

it('shows the saved printer name as text', async () => {
  const name = '<img id="printer-name-injection" src=x> & "Printer"'
  await setup({ name, slots: [{ slot_index: '0-0', present: true }] })
  expect(document.getElementById('printer-name-injection')).toBeNull()
  expect(document.getElementById('printer-slots-inline')!.textContent).toContain(name)
})

it('treats tooltip and context-menu data as text and round-trips encoded entities', async () => {
  const label = 'Rack &quot; & "spare"'
  const manufacturer = 'A" onpointerenter="test()'
  const filament = 'B &quot; C'
  const material = 'PLA" onpointerenter="test()'
  await setup({
    slots: [
      { slot_index: '0-0', present: true, slot_name: label },
      { slot_index: '0-1', present: true, tray_type: material },
      { slot_index: '0-2<img id="slot-index-injection" src=x>', present: true },
      { slot_index: '0-3', present: true, slot_name: '<img id="slot-label-injection" src=x>' },
    ],
    dbSlots: [{ slot_no: 0, assignment: { manufacturer_name: manufacturer, filament_name: filament, spool_id: 42 } }],
  })
  const [assigned, unassigned, unnamed, named] = slotDots()
  expect(assigned.title).toBe(`${manufacturer} - ${filament} - (#42)`)
  expect(unassigned.title).toBe(material)
  expect(unassigned.hasAttribute('onpointerenter')).toBe(false)
  expect(JSON.parse(assigned.dataset.slot!).slot_name).toBe(label)
  expect(JSON.parse(assigned.dataset.slot!)._assignment.filament_name).toBe(filament)
  expect(assigned.hasAttribute('onpointerenter')).toBe(false)
  assigned.click()
  expect(document.querySelector('[data-action="assign"]')?.previousElementSibling?.textContent).toBe(label)
  unnamed.click()
  expect(document.querySelector('[data-action="assign"]')?.previousElementSibling?.textContent).toContain('slot-index-injection')
  expect(document.getElementById('slot-index-injection')).toBeNull()
  named.click()
  expect(document.querySelector('[data-action="assign"]')?.previousElementSibling?.textContent).toContain('slot-label-injection')
  expect(document.getElementById('slot-label-injection')).toBeNull()
})

it('uses a neutral dot for a color containing CSS declarations or HTML', async () => {
  await setup({ slots: [
    { slot_index: '0-0', present: true, tray_color: '112233;position:fixed' },
    { slot_index: '0-1', present: true, tray_color: '112233" data-injected="x' },
    { slot_index: '0-2', present: true },
  ] })
  const [css, html, neutral] = slotDots()
  expect(css.getAttribute('style')).toBe(neutral.getAttribute('style'))
  expect(html.getAttribute('style')).toBe(neutral.getAttribute('style'))
  expect(html.hasAttribute('data-injected')).toBe(false)
})

it('waits for the requested spool in the requested slot even after a same-printer slot event', async () => {
  const slots = [
    { slot_index: '0-0', present: true, tray_color: 'FF0000FF', spool_id: 99 },
    { slot_index: '0-1', present: true, tray_color: 'FF0000FF', spool_id: 17 },
  ]
  await setup({ slots })
  const [dot] = slotDots()
  await assign(dot)
  window.dispatchEvent(new CustomEvent('filaman:data-changed', { detail: { event: 'slots_update', printer_id: 1 } }))
  expect(dot.classList.contains('slot-success')).toBe(false)
  await vi.advanceTimersByTimeAsync(3000)
  expect(dot.classList.contains('slot-success')).toBe(false)
  expect(dot.classList.contains('slot-sending')).toBe(true)

  slots[0] = { ...slots[0], tray_color: '0000FFFF', spool_id: 17 }
  await vi.advanceTimersByTimeAsync(3000)
  expect(dot.classList.contains('slot-success')).toBe(true)
})

it.each([null, undefined])('rejects a stale DB link when Bambu health reports spool_id %s', async spoolId => {
  await setup({
    slots: [{ slot_index: '0-0', present: true, tray_color: 'FF0000FF', spool_id: spoolId }],
    dbSlots: [{ slot_no: 0, assignment: { present: true, spool_id: 17 } }],
  })
  const [dot] = slotDots()
  await assign(dot)
  await vi.advanceTimersByTimeAsync(15000)
  expect(dot.classList.contains('slot-error')).toBe(true)
})

it('uses the refreshed active spool to show a legacy single Moonraker toolhead', async () => {
  await setup({
    driverKey: 'moonraker_filaman',
    slots: [{ slot_index: '0-0', slot_kind: 'toolhead', present: false, spool_id: null }],
    activeSpoolOnRefresh: 42,
    dbSlots: [{ slot_no: 0, assignment: { present: true, spool_id: 42, color_hex: '#112233' } }],
  })
  const [dot] = slotDots()
  expect(dot.title).toBe('(#42)')
  expect(dot.getAttribute('style')).toContain('background:#112233;')
})

it.each(['bambuddy', 'moonraker_filaman'])('uses live slot links for %s manual assignment', async driverKey => {
  const slots: Record<string, unknown>[] = [{ slot_index: '0-0', tray_color: '001122' }]
  await setup({ driverKey, slots })
  const [dot] = slotDots()
  await assign(dot)
  slots[0] = { ...slots[0], spool_id: 17 }
  await vi.advanceTimersByTimeAsync(3000)
  expect(dot.classList.contains('slot-success')).toBe(true)
})

it('keeps a second click from sending while profile coverage for the first is pending', async () => {
  let releaseCoverage: (response: Response) => void = () => {}
  const heldCoverage = new Promise<Response>(resolve => { releaseCoverage = resolve })
  let coverageReads = 0
  const http = await setup({
    slots: [{ slot_index: '0-0', present: true }, { slot_index: '0-1', present: true }],
    intercept: path => path.includes('/driver/profile-coverage') && ++coverageReads === 1 ? heldCoverage : undefined,
  })
  const [first, second] = slotDots()
  clickAssign(first)
  clickAssign(second)
  await vi.advanceTimersByTimeAsync(0)
  expect(http.calls.filter(call => call.method === 'POST')).toHaveLength(0)

  releaseCoverage(Response.json({}))
  await vi.advanceTimersByTimeAsync(0)
  expect(http.calls.filter(call => call.method === 'POST').map(call => call.body)).toEqual([
    expect.objectContaining({ params: expect.objectContaining({ tray_id: 0 }) }),
  ])
  expect(first.classList.contains('slot-sending')).toBe(true)
})

it.each(['cancel', 'abort'])('allows another assignment after profile coverage %s', async reason => {
  let firstCoverage = true
  vi.stubGlobal('confirm', () => false)
  const http = await setup({
    slots: [{ slot_index: '0-0', present: true }, { slot_index: '0-1', present: true }],
    intercept(path) {
      if (firstCoverage && path.endsWith('/driver/connected-models')) {
        return Response.json({ models: [{ model: 'P1S', printer_ids: [1] }] })
      }
      if (firstCoverage && path.includes('/driver/profile-coverage')) {
        firstCoverage = false
        if (reason === 'abort') return Promise.reject(new DOMException('Aborted', 'AbortError'))
        return Response.json({ coverage: { P1S: { status: 'missing' } } })
      }
    },
  })
  const [first, second] = slotDots()
  clickAssign(first)
  await vi.advanceTimersByTimeAsync(0)
  expect(http.calls.filter(call => call.method === 'POST')).toHaveLength(0)
  await assign(second)
  expect(http.calls.filter(call => call.method === 'POST').map(call => call.body)).toEqual([
    expect.objectContaining({ params: expect.objectContaining({ tray_id: 1 }) }),
  ])
})

it('finds the pending dot if a health refresh replaces a raw external key with its alias', async () => {
  let holdHealth = false
  let releaseHealth: (response: Response) => void = () => {}
  const heldHealth = new Promise<Response>(resolve => { releaseHealth = resolve })
  const slots = [{ slot_index: '255-254', present: true, spool_id: 42 }]
  await setup({ slots, intercept: path => {
    if (!holdHealth || !path.endsWith('/driver/health')) return
    holdHealth = false
    return heldHealth
  } })

  holdHealth = true
  window.dispatchEvent(new CustomEvent('filaman:data-changed', { detail: { event: 'slots_update', printer_id: 1 } }))
  await vi.advanceTimersByTimeAsync(200)
  await assign(slotDots()[0])
  slots[0] = { slot_index: '255-0', present: true, spool_id: 17 }
  releaseHealth(Response.json({ connected: true, driver_key: 'bambulab', slots }))
  await vi.advanceTimersByTimeAsync(0)
  const [refreshed] = slotDots()
  expect(refreshed.dataset.slotIndex).toBe('255-0')
  await vi.advanceTimersByTimeAsync(3000)
  expect(refreshed.classList.contains('slot-success')).toBe(true)
})

it('drops a printer that the refresh reports as disconnected', async () => {
  await setup({ slots: [{ slot_index: '0-0', present: true }], connectedOnRefresh: false })
  expect(slotDots()).toHaveLength(0)
})

it('resumes slot actions when the page is restored from the back-forward cache', async () => {
  const http = await setup({ slots: [{ slot_index: '0-0', present: true }] })
  window.dispatchEvent(new Event('pagehide'))
  window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }))
  await vi.advanceTimersByTimeAsync(200)
  await assign(slotDots()[0])
  expect(http.calls.filter(call => call.method === 'POST')).toHaveLength(1)
})

it('confirms a legacy single Moonraker toolhead using its live printer-wide spool ID', async () => {
  const options = {
    driverKey: 'moonraker_filaman',
    slots: [{ slot_index: '0-0', slot_kind: 'toolhead', present: false, spool_id: null }],
    activeSpoolId: 42,
  }
  await setup(options)
  const [dot] = slotDots()
  await assign(dot)
  await vi.advanceTimersByTimeAsync(3000)
  expect(dot.classList.contains('slot-success')).toBe(false)
  options.activeSpoolId = 17
  await vi.advanceTimersByTimeAsync(3000)
  expect(dot.classList.contains('slot-success')).toBe(true)
})
