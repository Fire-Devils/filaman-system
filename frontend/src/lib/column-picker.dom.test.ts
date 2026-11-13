// @vitest-environment happy-dom

import { afterEach, expect, it, vi } from 'vitest'
import { initColumnPicker } from './column-picker'

afterEach(() => {
  document.body.innerHTML = ''
  localStorage.clear()
})

it('resets narrow column choices without clearing the desktop layout', () => {
  document.body.innerHTML = `
    <main class="fm-main">
      <button id="columns">Columns</button>
      <div id="column-options"></div>
      <div class="fm-inventory-table" style="--fm-narrow-columns: 1">
        <table class="fm-table"><thead><tr><th class="col-logo">Logo</th></tr></thead></table>
      </div>
    </main>
  `
  localStorage.setItem('columns', '["logo"]')
  localStorage.setItem('columns-compact', '["logo"]')
  localStorage.setItem('column-order', '["logo"]')
  localStorage.setItem('column-widths', '{"logo":180}')
  const resetOrder = vi.fn()
  const resetWidths = vi.fn()
  const picker = initColumnPicker({
    storageKey: 'columns',
    defaultVisible: ['logo'],
    compactVisible: [],
    groups: [{ columns: [{ key: 'logo', label: 'Logo' }] }],
    btnId: 'columns',
    dropdownId: 'column-options',
    orderStorageKey: 'column-order',
    widthsStorageKey: 'column-widths',
    onReset: resetOrder,
    onResetWidths: resetWidths,
  })
  const toggle = document.getElementById('columns')!
  toggle.focus()
  toggle.click()
  toggle.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  expect(toggle.getAttribute('aria-expanded')).toBe('false')
  expect(document.activeElement).toBe(toggle)

  toggle.click()
  const reset = document.querySelector<HTMLButtonElement>('#column-options button')!
  reset.focus()
  reset.click()

  expect(document.activeElement).toBe(reset)
  expect(picker.isVisible('logo')).toBe(false)
  expect(localStorage.getItem('columns-compact')).toBeNull()
  expect(localStorage.getItem('columns')).toBe('["logo"]')
  expect(localStorage.getItem('column-order')).toBe('["logo"]')
  expect(localStorage.getItem('column-widths')).toBe('{"logo":180}')
  expect(resetOrder).not.toHaveBeenCalled()
  expect(resetWidths).not.toHaveBeenCalled()
})
