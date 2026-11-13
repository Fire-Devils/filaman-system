// @vitest-environment happy-dom

import { afterEach, expect, it, vi } from 'vitest'
import { initColumnPicker } from './column-picker'
import { initColumnReorder } from './column-reorder'
import { initHeaderColumnFilters, syncHeaderSortButtons } from './table-column-filters'

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

it('keeps selection pinned and moves the data lock after reordering and hiding columns', () => {
  document.body.innerHTML = `
    <main class="fm-main">
      <button id="columns">Columns</button>
      <div id="column-options"></div>
      <div class="fm-inventory-table">
        <table class="fm-table">
          <thead><tr>
            <th data-column-selection><input type="checkbox" aria-label="Select page"></th>
            <th class="col-name" data-sort="name" data-i18n="manufacturers.name">Name</th>
            <th class="col-logo">Logo</th>
            <th data-column-actions>Actions</th>
          </tr></thead>
          <tbody>
            <tr><td><input type="checkbox" aria-label="Select row"></td><td class="col-name">Paramount 3D</td><td class="col-logo">Logo</td><td>Edit</td></tr>
            <tr><td colspan="4">Grouped rows</td></tr>
          </tbody>
        </table>
      </div>
    </main>
  `
  const table = document.querySelector('table')!
  initColumnPicker({
    storageKey: 'test-columns',
    defaultVisible: ['name', 'logo'],
    compactVisible: ['name'],
    groups: [{ columns: [{ key: 'name', label: 'Name' }, { key: 'logo', label: 'Logo' }] }],
    btnId: 'columns',
    dropdownId: 'column-options',
  })
  initHeaderColumnFilters(table, [])
  localStorage.setItem('test-order', '["logo","name"]')
  const reorder = initColumnReorder({ tableSelector: '.fm-table', storageKey: 'test-order' })
  const start = table.querySelector<HTMLButtonElement>('button[data-column-lock="start"]')!
  const end = table.querySelector<HTMLButtonElement>('button[data-column-lock="end"]')!
  expect(start.closest('th')).toBe(table.querySelector('th.col-logo'))
  expect(start.getAttribute('aria-pressed')).toBe('true')
  expect(end.getAttribute('aria-pressed')).toBe('true')
  expect(table.querySelector('td.col-logo')?.getAttribute('data-column-pin')).toBe('start')
  expect(table.querySelector('th[data-column-selection]')?.getAttribute('data-column-pin')).toBe('selection')
  expect(table.querySelector('td:first-child')?.getAttribute('data-column-pin')).toBe('selection')
  expect(table.querySelector('td[colspan]')?.hasAttribute('data-column-pin')).toBe(false)

  start.focus()
  reorder.applyOrder()
  expect(document.activeElement).toBe(start)

  start.click()
  expect(start.getAttribute('aria-pressed')).toBe('false')
  expect(table.querySelector('[data-column-pin="start"]')).toBeNull()
  expect(table.querySelectorAll('[data-column-pin="selection"]')).toHaveLength(2)
  expect(table.querySelector('td:last-child')?.getAttribute('data-column-pin')).toBe('end')

  document.getElementById('columns')!.click()
  const logo = document.querySelector<HTMLInputElement>('input[data-col="logo"]')!
  logo.click()
  expect(start.closest('th')).toBe(table.querySelector('th.col-name'))
  syncHeaderSortButtons(table, 'name', 'asc')
  expect(table.querySelector('th.col-name .fm-header-sort-trigger')?.getAttribute('aria-pressed')).toBe('true')
  expect(start.getAttribute('aria-pressed')).toBe('false')
  start.click()
  expect(table.querySelector('td.col-name')?.getAttribute('data-column-pin')).toBe('start')

  logo.click()
  reorder.resetOrder()
  expect(start.closest('th')).toBe(table.querySelector('th.col-name'))
})
