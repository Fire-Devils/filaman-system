// @vitest-environment happy-dom
import { expect, it } from 'vitest'
import { fdbContribCell, loadContribContext } from './filamentdb-contrib'

it('fdbContribCell shows a text pill for a contribution and a muted dash otherwise', () => {
  document.body.innerHTML = `<p>${fdbContribCell({ status: 'pending' })}</p><p>${fdbContribCell(null)}</p>`
  const cells = document.querySelectorAll('p > span')
  expect(cells[0].getAttribute('data-fdb-status')).toBe('pending')
  expect(cells[0].classList.contains('fdb-status-icon')).toBe(false)
  expect(cells[1].getAttribute('data-fdb-submitted')).toBe('false')
})

it('resets the cached contrib context on client navigation (astro:after-swap)', () => {
  const first = loadContribContext()
  expect(loadContribContext()).toBe(first)
  document.dispatchEvent(new Event('astro:after-swap'))
  expect(loadContribContext()).not.toBe(first)
})
