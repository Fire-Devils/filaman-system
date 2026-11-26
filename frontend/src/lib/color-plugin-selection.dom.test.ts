// @vitest-environment happy-dom
import {afterEach, expect, it, vi} from 'vitest'
import { colorCleanupFixture } from '../../tests/helpers/color-cleanup'
import {bindColorCleanup} from './color-library-cleanup'
vi.mock('./color-wheel', async importOriginal => ({
  ...await importOriginal<typeof import('./color-wheel')>(), neutralWheelPalette: vi.fn(() => ({ background: 'none' })),
}))
const controller = new AbortController()
afterEach(() => {controller.abort();document.body.replaceChildren(); vi.unstubAllGlobals()})
it('lets update-only users select all matching explicit IDs without granting native deletion', async () => {
  document.body.innerHTML = await colorCleanupFixture()
  const colors = Array.from({length: 75}, (_, i) => ({id: i+1, name: 'Color', hex_code: '#FF0000', usage_count: 0}))
  const changed = vi.fn(), fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
  const control = bindColorCleanup({scope: document.body, getColors: () => colors, getVisible: () => colors,
    reload: vi.fn(), signal: controller.signal, canMerge: false, canDelete: false, canSelect: true, onSelectionChange: changed})
  control.syncSelection()
  expect(document.querySelector<HTMLInputElement>('[data-color-select]')!.disabled).toBe(false)
  document.querySelector<HTMLButtonElement>('#color-select-matching')!.click()
  expect(control.getSelectedIds()).toHaveLength(75)
  const snapshot = control.getSelectedIds(); snapshot.pop()
  expect(control.getSelectedIds()).toHaveLength(75)
  const merge = document.querySelector<HTMLButtonElement>('#color-merge-selected')!
  expect(merge.hidden).toBe(true); expect(merge.disabled).toBe(true); merge.click(); expect(fetch).not.toHaveBeenCalled()
  const remove = document.querySelector<HTMLButtonElement>('#color-delete-selected')!
  expect(remove.disabled).toBe(true); remove.click(); expect(fetch).not.toHaveBeenCalled()
  document.querySelector<HTMLButtonElement>('#color-clear-selection')!.click()
  expect(control.getSelectedIds()).toEqual([]); expect(changed).toHaveBeenCalled()
})
