// @vitest-environment happy-dom
import {afterEach, expect, it, vi} from 'vitest'
import {bindColorCleanup} from './color-library-cleanup'
afterEach(() => {document.body.replaceChildren(); vi.unstubAllGlobals()})
it('lets update-only users select all matching explicit IDs without granting native deletion', () => {
  document.body.innerHTML = `<button id="btn-review-colors"></button><button id="color-select-matching"></button>
    <button id="color-clear-selection"></button><button id="color-delete-selected"></button>
    <span id="color-selection-count"></span><input id="color-select-loaded" type="checkbox">
    <table id="colors-list-table"><tbody><tr><td><input data-color-select="1"></td></tr></tbody></table>
    <dialog id="color-cleanup-dialog"><div id="color-cleanup-content"></div></dialog>`
  const colors = Array.from({length: 75}, (_, i) => ({id: i+1, name: 'Color', hex_code: '#FF0000', usage_count: 0}))
  const changed = vi.fn(), fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
  const control = bindColorCleanup({scope: document.body, getColors: () => colors, getVisible: () => colors,
    reload: vi.fn(), signal: new AbortController().signal, canMerge: false, canDelete: false, canSelect: true, onSelectionChange: changed})
  control.syncSelection()
  expect(document.querySelector<HTMLInputElement>('[data-color-select]')!.disabled).toBe(false)
  document.querySelector<HTMLButtonElement>('#color-select-matching')!.click()
  expect(control.getSelectedIds()).toHaveLength(75)
  const snapshot = control.getSelectedIds(); snapshot.pop()
  expect(control.getSelectedIds()).toHaveLength(75)
  const remove = document.querySelector<HTMLButtonElement>('#color-delete-selected')!
  expect(remove.disabled).toBe(true); remove.click(); expect(fetch).not.toHaveBeenCalled()
  document.querySelector<HTMLButtonElement>('#color-clear-selection')!.click()
  expect(control.getSelectedIds()).toEqual([]); expect(changed).toHaveBeenCalled()
})
