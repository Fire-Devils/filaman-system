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
