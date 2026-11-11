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
