// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { bindColorCleanup, type CleanupColor } from './color-library-cleanup'

const item = (id: number, fields: Record<string, unknown> = {}): CleanupColor => ({ id, name: `Color ${id}`, hex_code: '#AABBCC', usage_count: 0, custom_fields: fields, token: String(id).padStart(64, '0') })
afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = '' })
function setup(items: CleanupColor[], groups: number[][]) {
  document.body.innerHTML = `<button id="btn-review-colors"></button><button id="color-select-matching"></button><button id="color-clear-selection"></button><button id="color-delete-selected"></button><span id="color-selection-count"></span><input id="color-select-loaded" type="checkbox"><table id="colors-list-table"><tbody></tbody></table><dialog id="color-cleanup-dialog"><button data-dialog-close>Close</button><div id="color-cleanup-content"></div></dialog>`
  const dialog = document.querySelector('dialog')!
  dialog.showModal = () => { dialog.open = true }
  dialog.close = () => { dialog.open = false; dialog.dispatchEvent(new Event('close')) }
  const commands: { url: string; body: { records: { id: number }[]; fields?: Record<string, unknown> } }[] = []
  let rejected = false
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    if (options?.method === 'POST') {
      commands.push({ url, body: JSON.parse(String(options.body)) })
      return { ok: !rejected, json: async () => rejected ? { detail: { message: 'Review changed' } } : { changed: 1 } }
    }
    return { ok: true, json: async () => ({ items, groups }) }
  }))
  const reload = vi.fn(async () => {})
  const control = bindColorCleanup({ scope: document.body, getColors: () => items, getVisible: () => items, reload, signal: new AbortController().signal, canMerge: true, canDelete: true })
  return { ...control, dialog, reload, commands, reject: () => { rejected = true } }
}
async function click(selector: string) {
  document.querySelector<HTMLButtonElement>(selector)!.click()
  await vi.waitFor(() => expect(document.querySelector('#color-cleanup-content')!.textContent).not.toContain('Loading...'))
  await Promise.resolve()
}
it('selects all matching colors including unloaded rows and confirms the exact count', async () => {
  const control = setup(Array.from({ length: 75 }, (_, i) => item(i + 1)), [])
  const clear = document.querySelector<HTMLButtonElement>('#color-clear-selection')!
  const remove = document.querySelector<HTMLButtonElement>('#color-delete-selected')!
  expect(clear.hidden).toBe(true)
  expect(remove.hidden).toBe(true)
  await click('#color-select-matching')
  expect(clear.hidden).toBe(false)
  expect(remove.hidden).toBe(false)
  await click('#color-clear-selection')
  expect(clear.hidden).toBe(true)
  expect(remove.hidden).toBe(true)
  await click('#color-select-matching')
  expect(document.querySelector('#color-selection-count')!.textContent).toContain('75')
  await click('#color-delete-selected')
  expect(control.dialog.textContent).toContain('75')
  expect(control.dialog.querySelector('[role="note"]')!.textContent).toContain('This cannot be undone.')
  expect(control.commands).toHaveLength(0)
  await click('[data-dialog-close]')
  expect(control.commands).toHaveLength(0)
  await click('#color-delete-selected')
  expect(control.dialog.querySelector('[data-cleanup-confirm-delete]')!.classList.contains('fm-btn-danger')).toBe(true)
  await click('[data-cleanup-confirm-delete]')
  await vi.waitFor(() => expect(control.reload).toHaveBeenCalledOnce())
  expect(control.commands[0].body.records).toHaveLength(75)
  expect(control.dialog.open).toBe(false)
})
it('merges three duplicates using only the chosen color and name', async () => {
  const control = setup([item(1, { note: 'legacy data' }), item(2), item(3)], [[1, 2, 3]])
  await click('#btn-review-colors')
  expect(document.querySelectorAll('[data-merge-entry]')).toHaveLength(3)
  expect([...document.querySelectorAll('.fm-cleanup-entry-letter')].map(element => element.textContent)).toEqual(['A', 'B', 'C'])
  expect(control.dialog.textContent).not.toContain('legacy data')
  expect(control.dialog.querySelector('[data-field-choice], textarea, dl')).toBeNull()
  const survivor = document.querySelector<HTMLSelectElement>('#cleanup-survivor')!
  survivor.value = '2'; survivor.dispatchEvent(new Event('change', { bubbles: true }))
  document.querySelector<HTMLInputElement>('#cleanup-name')!.value = 'Combined blue'
  const other = document.querySelector<HTMLInputElement>('[data-merge-entry="1"]')!
  other.checked = false; other.dispatchEvent(new Event('change', { bubbles: true }))
  other.checked = true; other.dispatchEvent(new Event('change', { bubbles: true }))
  await click('[data-cleanup-merge]')
  await vi.waitFor(() => expect(control.commands).toHaveLength(1))
  expect(control.commands[0].body).toEqual({ records: [1, 2, 3].map(id => ({ id, token: String(id).padStart(64, '0') })), survivor_id: 2, name: 'Combined blue' })
})
it('keeps rejected operations reviewable and never retries without another confirmation', async () => {
  const control = setup([item(1)], [])
  await click('#color-select-matching'); await click('#color-delete-selected')
  control.reject()
  await click('[data-cleanup-confirm-delete]')
  await vi.waitFor(() => expect(control.dialog.textContent).toContain('Review changed'))
  expect(control.dialog.open).toBe(true)
  expect(control.reload).not.toHaveBeenCalled()
  await click('[data-cleanup-refresh]')
  expect(control.commands).toHaveLength(1)
})
it('skips a group without changing it and reviews the next group', async () => {
  const control = setup([item(1), item(2), item(3), item(4)], [[1, 2], [3, 4]])
  await click('#btn-review-colors'); await click('[data-cleanup-skip]')
  expect(document.querySelector('[data-merge-entry]')!.getAttribute('data-merge-entry')).toBe('3')
  expect(control.commands).toHaveLength(0)
})

it('keeps skipped duplicate groups skipped when the review refreshes', async () => {
  const control = setup([item(1), item(2), item(3), item(4)], [[1, 2], [3, 4]])
  await click('#btn-review-colors'); await click('[data-cleanup-skip]')
  // A rejected merge offers refresh without silently retrying it.
  control.reject()
  await click('[data-cleanup-merge]')
  await vi.waitFor(() => expect(control.dialog.textContent).toContain('Review changed'))
  await click('[data-cleanup-refresh]')
  expect(document.querySelector('[data-merge-entry]')!.getAttribute('data-merge-entry')).toBe('3')
})

it('keeps a single duplicate deletion targeted after refresh even with a bulk table selection', async () => {
  const control = setup([item(1), item(2), item(3), item(4), item(5)], [[1, 2]])
  await click('#color-select-matching'); await click('#btn-review-colors')
  await click('[data-cleanup-delete-one="1"]')
  control.reject()
  await click('[data-cleanup-confirm-delete]')
  await vi.waitFor(() => expect(control.dialog.textContent).toContain('Review changed'))
  await click('[data-cleanup-refresh]')
  await click('[data-cleanup-confirm-delete]')
  await vi.waitFor(() => expect(control.commands).toHaveLength(2))
  expect(control.commands.map(command => command.body.records.map(record => record.id))).toEqual([[1], [1]])
})

it('offers Next only with another group and always lets Close leave the group unchanged', async () => {
  const control = setup([item(1), item(2), item(3), item(4)], [[1, 2], [3, 4]])
  await click('#btn-review-colors')
  expect(document.querySelector('[data-cleanup-skip]')!.textContent).toBe('Next')
  await click('[data-cleanup-skip]')
  expect(document.querySelector('[data-cleanup-skip]')).toBeNull()
  await click('[data-dialog-close]')
  expect(control.dialog.open).toBe(false)
  expect(control.commands).toHaveLength(0)
})


it('keeps a non-JSON server failure reviewable without exposing a parser error', async () => {
  const control = setup([item(1)], [])
  await click('#color-select-matching'); await click('#color-delete-selected')
  vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>Bad gateway</html>', { status: 502 })))
  await click('[data-cleanup-confirm-delete]')
  await vi.waitFor(() => expect(control.dialog.querySelector('[role="alert"]')!.textContent).toBe('Color cleanup failed (502)'))
  expect(control.dialog.open).toBe(true)
  expect(control.reload).not.toHaveBeenCalled()
  expect(control.dialog.querySelector<HTMLButtonElement>('[data-cleanup-confirm-delete]')!.disabled).toBe(false)
})
