// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { captureDetailEditPosition } from './detail-edit-position'

afterEach(() => { document.body.innerHTML = ''; vi.restoreAllMocks() })
it('keeps the visible section at the same screen position as preceding content changes', () => {
  document.body.innerHTML = '<main><div class="detail-page-toolbar"></div><h2>Material</h2><h2 id="printer-setup-title">Printer settings</h2></main>'
  const main = document.querySelector('main')!
  main.scrollTop = 800
  const heading = document.getElementById('printer-setup-title')!
  let contentTop = 1000
  vi.spyOn(heading, 'getBoundingClientRect').mockImplementation(() => ({ top: contentTop - main.scrollTop, bottom: contentTop - main.scrollTop + 30, height: 30 } as DOMRect))
  vi.spyOn(document.querySelector('h2')!, 'getBoundingClientRect').mockReturnValue({ top: -600, bottom: -570, height: 30 } as DOMRect)
  vi.spyOn(main.querySelector('.detail-page-toolbar')!, 'getBoundingClientRect').mockReturnValue({ bottom: 100 } as DOMRect)
  const restore = captureDetailEditPosition(main)
  contentTop = 1600
  restore()
  expect(main.scrollTop).toBe(1400)
  expect(heading.getBoundingClientRect().top).toBe(200)
  main.scrollTop = 1550 // Deliberate scroll while profile controls are loading.
  contentTop = 1700
  restore()
  expect(main.scrollTop).toBe(1550)
})
it('falls back to the original scroll position without matching section headings', () => {
  document.body.innerHTML = '<main></main>'
  const main = document.querySelector('main')!
  main.scrollTop = 640
  const restore = captureDetailEditPosition(main)
  main.scrollTop = 0
  restore()
  expect(main.scrollTop).toBe(640)
})
it('uses the next surviving section when the first visible heading is removed in edit mode', () => {
  document.body.innerHTML = '<main><div class="detail-page-toolbar"></div><h2 id="removed-heading">Extra Fields</h2><h2 id="printer-setup-title">Printer settings</h2></main>'
  const main = document.querySelector('main')!; main.scrollTop = 800
  const heading = document.getElementById('printer-setup-title')!
  let contentTop = 1150
  vi.spyOn(heading, 'getBoundingClientRect').mockImplementation(() => ({ top: contentTop - main.scrollTop, bottom: contentTop - main.scrollTop + 30, height: 30 } as DOMRect))
  vi.spyOn(document.getElementById('removed-heading')!, 'getBoundingClientRect').mockReturnValue({ top: 120, bottom: 150, height: 30 } as DOMRect)
  vi.spyOn(main.querySelector('.detail-page-toolbar')!, 'getBoundingClientRect').mockReturnValue({ bottom: 100 } as DOMRect)
  const restore = captureDetailEditPosition(main)
  document.getElementById('removed-heading')!.remove()
  contentTop = 1550
  restore()
  expect(main.scrollTop).toBe(1200)
  expect(heading.getBoundingClientRect().top).toBe(350)
})
