// @vitest-environment happy-dom
import { bootAstroPage } from '../../tests/helpers/astro-page'
import { afterEach, expect, it, vi } from 'vitest'
import * as i18n from './i18n'
import * as swatch from './ams-swatch'
import { renderSpoolReel } from './spool-reel'

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.replaceChildren()
  history.replaceState(null, '', '/')
})

it('updates printer and AMS telemetry without replacing unchanged reels', async () => {
  i18n.setLang('en')
  const makeUnit = (id: number) => ({
    ams_id: id, kind: 'ams', label: `AMS ${id + 1}`, temperature: 26,
    slots: [{ label: `${id + 1}A`, color: '#E8D9BD', remaining_percent: 82, remaining_grams: 820, spool_id: id + 1 }],
  })
  const printer = { id: 1, name: 'X1 Carbon', temperatures: { nozzle: 220 }, ams: [makeUnit(0), makeUnit(1)] }
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ printers: [printer] })))
  let poll!: () => Promise<void>
  await bootAstroPage('display', {
    ...i18n, ...swatch, renderSpoolReel, initI18n: async () => {},
    getAbortSignal: () => undefined, isAbortError: () => false,
    setInterval: (callback: () => Promise<void>) => { poll = callback },
  })

  const reels = () => [...document.querySelectorAll('.spool-reel-corner')]
  const [first, second] = reels()
  expect(first).toBeDefined()
  expect(second).toBeDefined()

  printer.temperatures.nozzle = 221
  printer.ams[0].temperature = 27
  await poll()
  expect(document.querySelector('.ams-printer-head')?.textContent).toContain('Nozzle 221°C')
  expect(document.querySelector('.ams-unit-head')?.textContent).toContain('27°C')
  expect(reels()[0]).toBe(first)
  expect(reels()[1]).toBe(second)

  printer.ams[0].slots[0].remaining_percent = 42
  printer.ams[0].slots[0].remaining_grams = 420
  await poll()
  expect(document.querySelector('.ams-bay')?.textContent).toContain('42% left')
  expect(reels()[0]).not.toBe(first)
  expect(reels()[1]).toBe(second)

  printer.ams.unshift({ ...makeUnit(2), kind: 'ams_ht' })
  await poll()
  expect(document.querySelectorAll('.ams-row-main .spool-reel-corner')).toHaveLength(2)
  expect(document.querySelector('.ams-row-aux .ams-unit-name')?.textContent).toBe('AMS 3')
  expect(document.querySelector('.ams-row-aux .spool-reel-corner')).not.toBeNull()
})

it('tells the truth about untracked bays, unknown colour, loaded vs printing and a lost feed', async () => {
  i18n.setLang('en')
  const printer: any = {
    id: 7, name: 'H2D', connected: true, state: 'FINISH', active: { ams_id: 0, slot: 1 },
    ams: [{
      ams_id: 0, kind: 'ams', model: 'ams_2_pro', label: 'AMS A',
      slots: [
        { ams_id: 0, slot: 0, label: 'A1', color: '#EDFF00', material: 'PLA', spool_id: null, remaining_percent: 0, remaining_source: 'printer' },
        { ams_id: 0, slot: 1, label: 'A2', color: '#1729AB', colors: ['#1729AB'], color_name: 'Klein Blue', material: 'PLA', spool_id: 123, remaining_percent: 90, remaining_grams: 900, remaining_source: 'filaman', active: true },
        { ams_id: 0, slot: 2, label: 'A3', color: '#202020', material: 'PETG', spool_id: null, remaining_percent: null },
        { ams_id: 0, slot: 3, label: 'A4', color: '#FF0000', color_name: 'Red', material: 'PETG', spool_id: 9, remaining_percent: 12, remaining_grams: 80 },
      ],
    }],
  }
  let fail = false
  vi.stubGlobal('fetch', vi.fn(async () => fail ? new Response('', { status: 503 }) : Response.json({ printers: [printer] })))
  let poll!: () => Promise<void>
  await bootAstroPage('display', {
    ...i18n, ...swatch, renderSpoolReel, initI18n: async () => {},
    getAbortSignal: () => undefined, isAbortError: () => false,
    setInterval: (callback: () => Promise<void>) => { poll = callback },
  })

  const bay = (label: string) => [...document.querySelectorAll<HTMLElement>('.ams-bay')].find(b => b.querySelector('.ams-bay-label')?.textContent === label)!
  expect(bay('A1').dataset.level).toBe('untracked')
  expect(bay('A1').textContent).toContain('Not tracked')
  expect(bay('A1').textContent).not.toContain('0% left')
  expect(bay('A3').querySelector('.ams-swatch')?.getAttribute('data-unknown')).toBe('1')
  expect(bay('A4').dataset.level).toBe('crit')
  expect(bay('A2').textContent).toContain('Loaded')
  expect(document.querySelector('.ams-state')?.textContent).toBe('Finished')

  printer.state = 'RUNNING'
  await poll()
  expect(bay('A2').textContent).toContain('Printing')

  bay('A2').click()
  const panel = document.getElementById('ams-detail')!
  expect(panel.hidden).toBe(false)
  expect(panel.querySelector('a[href="/spools/123"]')).not.toBeNull()
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
  expect(panel.hidden).toBe(true)

  fail = true
  await poll(); await poll()
  expect(document.getElementById('ams-stale')!.hidden).toBe(true)
  await poll()
  expect(document.getElementById('ams-stale')!.hidden).toBe(false)
  fail = false
  await poll()
  expect(document.getElementById('ams-stale')!.hidden).toBe(true)
})

it('marks the board stale when a request hangs instead of failing', async () => {
  i18n.setLang('en')
  let hang = false
  const now = vi.spyOn(Date, 'now')
  let clock = 1_000_000
  now.mockImplementation(() => clock)
  vi.stubGlobal('fetch', vi.fn(() => hang ? new Promise<Response>(() => {}) : Promise.resolve(Response.json({ printers: [] }))))
  let poll!: () => Promise<void>
  await bootAstroPage('display', {
    ...i18n, ...swatch, renderSpoolReel, initI18n: async () => {},
    getAbortSignal: () => undefined, isAbortError: () => false,
    setInterval: (callback: () => Promise<void>) => { poll = callback },
  })

  hang = true
  void poll()
  clock += 10_000
  await poll()
  expect(document.getElementById('ams-stale')!.hidden).toBe(true)
  clock += 25_000
  await poll()
  expect(document.getElementById('ams-stale')!.hidden).toBe(false)
  now.mockRestore()
})

it('hides and shows the external spool holders and remembers the choice', async () => {
  i18n.setLang('en')
  localStorage.removeItem('filaman.amsView.showExternal')
  const printer = {
    id: 3, name: 'P2S', ams: [
      { ams_id: 0, kind: 'ams', label: 'AMS A', slots: [{ ams_id: 0, slot: 0, label: 'A1', empty: true }] },
      { ams_id: 255, kind: 'external', label: 'External', slots: [{ ams_id: 255, slot: 0, label: 'Ext1', empty: true }] },
    ],
  }
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ printers: [printer] })))
  await bootAstroPage('display', {
    ...i18n, ...swatch, renderSpoolReel, initI18n: async () => {},
    getAbortSignal: () => undefined, isAbortError: () => false,
    setInterval: () => {},
  })
  const toggle = document.getElementById('ams-ext')!
  expect(document.querySelector('.ams-unit[data-kind="external"]')).not.toBeNull()
  expect(toggle.getAttribute('aria-pressed')).toBe('true')
  toggle.click()
  expect(document.querySelector('.ams-unit[data-kind="external"]')).toBeNull()
  expect(toggle.getAttribute('aria-pressed')).toBe('false')
  expect(localStorage.getItem('filaman.amsView.showExternal')).toBe('0')
  toggle.click()
  expect(document.querySelector('.ams-unit[data-kind="external"]')).not.toBeNull()
  localStorage.removeItem('filaman.amsView.showExternal')
})

it('points the strip, highlight and feed line at the printer-reported active slot', async () => {
  i18n.setLang('en')
  const slot = (n: number, extra = {}) => ({ ams_id: 1, slot: n, label: `B${n + 1}`, color: '#FF0000', material: 'PLA', spool_id: 10 + n, remaining_percent: 50, ...extra })
  const printer: any = {
    id: 9, name: 'H2D', state: 'RUNNING', active: { ams_id: 1, slot: 2 },
    ams: [
      { ams_id: 0, kind: 'ams', label: 'AMS A', slots: [{ ams_id: 0, slot: 2, label: 'A3', color: '#00FF00', material: 'PLA', spool_id: 3, remaining_percent: 40 }] },
      { ams_id: 1, kind: 'ams', label: 'AMS B', slots: [slot(0, { active: true }), slot(1), slot(2), slot(3)] },
    ],
  }
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ printers: [printer] })))
  let poll!: () => Promise<void>
  await bootAstroPage('display', {
    ...i18n, ...swatch, renderSpoolReel, initI18n: async () => {},
    getAbortSignal: () => undefined, isAbortError: () => false,
    setInterval: (callback: () => Promise<void>) => { poll = callback },
  })
  const active = () => [...document.querySelectorAll<HTMLElement>('.ams-bay[data-active="1"]')].map(b => b.dataset.key)
  expect(active()).toEqual(['9:1:2'])
  expect(document.querySelector<HTMLElement>('.ams-loaded-dot')?.dataset.bay).toBe('9:1:2')
  expect(document.querySelector('.ams-loaded')?.textContent).toContain('B3')

  printer.active = { ams_id: 0, slot: 2 }
  await poll()
  expect(active()).toEqual(['9:0:2'])
  expect(document.querySelector<HTMLElement>('.ams-loaded-dot')?.dataset.bay).toBe('9:0:2')
})

it('runs the feed line to the bay row that holds the loaded bay when a unit wraps to 2×2', async () => {
  i18n.setLang('en')
  const slot = (n: number) => ({ ams_id: 0, slot: n, label: `A${n + 1}`, color: '#00FF00', material: 'PLA', spool_id: 10 + n, remaining_percent: 50 })
  const printer: any = {
    id: 9, name: 'H2D', state: 'RUNNING', active: { ams_id: 0, slot: 2 },
    ams: [{ ams_id: 0, kind: 'ams', label: 'AMS A', slots: [slot(0), slot(1), slot(2), slot(3)] }],
  }
  // A 2×2 unit under the strip: A1 A2 on top, A3 A4 below.
  const rect = (left: number, top: number, width: number, height: number) =>
    ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect
  const bays: Record<string, DOMRect> = {
    '9:0:0': rect(10, 160, 180, 150), '9:0:1': rect(210, 160, 180, 150),
    '9:0:2': rect(10, 320, 180, 150), '9:0:3': rect(210, 320, 180, 150),
  }
  const measure = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains('ams-bay')) return bays[this.dataset.key || ''] ?? rect(0, 0, 0, 0)
    if (this.classList.contains('ams-loaded-dot')) return rect(20, 40, 12, 12)
    if (this.classList.contains('ams-printer-head')) return rect(0, 0, 400, 100)
    if (this.classList.contains('ams-unit')) return rect(0, 120, 400, 360)
    return rect(0, 0, 400, 480)
  })
  const frames: FrameRequestCallback[] = []
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback))
  const draw = () => { frames.splice(0).forEach(callback => callback(0)) }
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ printers: [printer] })))
  let poll!: () => Promise<void>
  await bootAstroPage('display', {
    ...i18n, ...swatch, renderSpoolReel, initI18n: async () => {},
    getAbortSignal: () => undefined, isAbortError: () => false,
    setInterval: (callback: () => Promise<void>) => { poll = callback },
  })
  const path = () => document.querySelector('.ams-feed-core')?.getAttribute('d') || ''

  // A3 is in the lower row: along the gap between the rows (y 315), then
  // down onto A3 itself, never ending on A1 above it.
  draw()
  expect(path()).toContain(' 315 ')
  expect(path().endsWith('L 100 320')).toBe(true)

  // A1 is in the top row: the line stops at the top of the unit, over A1.
  printer.active = { ams_id: 0, slot: 0 }
  await poll()
  draw()
  expect(path()).not.toContain(' 315 ')
  expect(path().endsWith('L 100 120')).toBe(true)
  measure.mockRestore()
})
