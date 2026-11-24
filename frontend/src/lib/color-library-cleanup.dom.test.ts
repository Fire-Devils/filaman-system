// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { colorCleanupFixture } from '../../tests/helpers/color-cleanup'
import { bindColorCleanup, type CleanupColor } from './color-library-cleanup'

const item = (id: number, fields: Record<string, unknown> = {}): CleanupColor => ({ id, name: `Color ${id}`, hex_code: '#AABBCC', usage_count: 0, custom_fields: fields, token: String(id).padStart(64, '0') })
vi.mock('./color-wheel', async importOriginal => ({
  ...await importOriginal<typeof import('./color-wheel')>(), neutralWheelPalette: vi.fn(() => ({ background: 'none' })),
}))
const controllers: AbortController[] = []
afterEach(() => { controllers.splice(0).forEach(controller => controller.abort()); vi.unstubAllGlobals(); document.body.innerHTML = '' })
async function setup(items: CleanupColor[], groups: number[][]) {
  document.body.innerHTML = await colorCleanupFixture()
  const dialog = document.querySelector('dialog')!
  dialog.showModal = () => { dialog.open = true }
  dialog.close = () => { dialog.open = false; dialog.dispatchEvent(new Event('close')) }
  const commands: { url: string; body: { records: { id: number }[]; fields?: Record<string, unknown> } }[] = []
  let rejected = false
  let refreshOffline = false
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    if (options?.method === 'POST') {
      commands.push({ url, body: JSON.parse(String(options.body)) })
      return { ok: !rejected, json: async () => rejected ? { detail: { message: 'Review changed' } } : { changed: 1 } }
    }
    if (refreshOffline) return { ok: false }
    return { ok: true, json: async () => ({ items: structuredClone(items), groups: structuredClone(groups) }) }
  }))
  const reload = vi.fn(async () => {})
  const controller = new AbortController(); controllers.push(controller)
  const control = bindColorCleanup({ scope: document.body, getColors: () => items, getVisible: () => items, reload, signal: controller.signal, canMerge: true, canDelete: true })
  return { ...control, dialog, reload, commands, reject: () => { rejected = true }, setRefreshOffline: (value: boolean) => { refreshOffline = value } }
}
async function click(selector: string) {
  document.querySelector<HTMLButtonElement>(selector)!.click()
  await vi.waitFor(() => expect(document.querySelector('#color-cleanup-content')!.textContent).not.toContain('Loading...'))
  await Promise.resolve()
}
it('selects all matching colors including unloaded rows and confirms the exact count', async () => {
  const control = await setup(Array.from({ length: 75 }, (_, i) => item(i + 1)), [])
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
  expect(control.dialog.querySelector('[role="note"]')!.textContent).toBe('Delete these 75 colors? Only unused colors can be deleted. This cannot be undone.')
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
  const control = await setup([item(1, { note: 'legacy data' }), item(2), item(3)], [[1, 2, 3]])
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
  expect(control.commands[0].body).toEqual({ records: [1, 2, 3].map(id => ({ id, token: String(id).padStart(64, '0') })), survivor_id: 2, name: 'Combined blue', hex_code: '#AABBCC' })
})
it('keeps rejected operations reviewable and never retries without another confirmation', async () => {
  const control = await setup([item(1)], [])
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
  const control = await setup([item(1), item(2), item(3), item(4)], [[1, 2], [3, 4]])
  await click('#btn-review-colors'); await click('[data-cleanup-skip]')
  expect(document.querySelector('[data-merge-entry]')!.getAttribute('data-merge-entry')).toBe('3')
  expect(control.commands).toHaveLength(0)
})

it('keeps skipped duplicate groups skipped when the review refreshes', async () => {
  const control = await setup([item(1), item(2), item(3), item(4)], [[1, 2], [3, 4]])
  await click('#btn-review-colors'); await click('[data-cleanup-skip]')
  // A rejected merge offers refresh without silently retrying it.
  control.reject()
  await click('[data-cleanup-merge]')
  await vi.waitFor(() => expect(control.dialog.textContent).toContain('Review changed'))
  await click('[data-cleanup-refresh]')
  expect(document.querySelector('[data-merge-entry]')!.getAttribute('data-merge-entry')).toBe('3')
})

it('keeps a single duplicate deletion targeted after refresh even with a bulk table selection', async () => {
  const control = await setup([item(1), item(2), item(3), item(4), item(5)], [[1, 2]])
  await click('#color-select-matching'); await click('#btn-review-colors')
  await click('[data-cleanup-delete-one="1"]')
  expect(control.dialog.querySelector('[role="note"]')!.textContent).toBe('Delete this color? Only unused colors can be deleted. This cannot be undone.')
  control.reject()
  await click('[data-cleanup-confirm-delete]')
  await vi.waitFor(() => expect(control.dialog.textContent).toContain('Review changed'))
  await click('[data-cleanup-refresh]')
  await click('[data-cleanup-confirm-delete]')
  await vi.waitFor(() => expect(control.commands).toHaveLength(2))
  expect(control.commands.map(command => command.body.records.map(record => record.id))).toEqual([[1], [1]])
})

it('offers Next only with another group and always lets Close leave the group unchanged', async () => {
  const control = await setup([item(1), item(2), item(3), item(4)], [[1, 2], [3, 4]])
  await click('#btn-review-colors')
  expect(document.querySelector('[data-cleanup-skip]')!.textContent).toBe('Next')
  await click('[data-cleanup-skip]')
  expect(document.querySelector('[data-cleanup-skip]')).toBeNull()
  await click('[data-dialog-close]')
  expect(control.dialog.open).toBe(false)
  expect(control.commands).toHaveLength(0)
})


it('keeps a non-JSON server failure reviewable without exposing a parser error', async () => {
  const control = await setup([item(1)], [])
  await click('#color-select-matching'); await click('#color-delete-selected')
  vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>Bad gateway</html>', { status: 502 })))
  await click('[data-cleanup-confirm-delete]')
  await vi.waitFor(() => expect(control.dialog.querySelector('[role="alert"]')!.textContent).toBe('Color cleanup failed (502)'))
  expect(control.dialog.open).toBe(true)
  expect(control.reload).not.toHaveBeenCalled()
  expect(control.dialog.querySelector<HTMLButtonElement>('[data-cleanup-confirm-delete]')!.disabled).toBe(false)
})

it('combines the captured matching selection with a custom alpha HEX and preserves its draft after refresh', async () => {
  const items = Array.from({ length: 75 }, (_, i) => ({ ...item(i + 1), hex_code: i % 2 ? '#FF0000' : '#0000FF80' }))
  const control = await setup(items, [])
  const merge = document.querySelector<HTMLButtonElement>('#color-merge-selected')!
  expect(merge.hidden).toBe(true)
  const checkbox = document.querySelector<HTMLInputElement>('[data-color-select="1"]')!
  checkbox.checked = true; checkbox.dispatchEvent(new Event('change', { bubbles: true }))
  expect(merge.hidden).toBe(true)
  await click('#color-select-matching')
  expect(merge.hidden).toBe(false)
  await click('#color-merge-selected')
  expect(document.querySelectorAll('[data-merge-entry]')).toHaveLength(75)
  const name = document.querySelector<HTMLInputElement>('#cleanup-name')!
  const hex = document.querySelector<HTMLInputElement>('#cleanup-hex')!
  name.value = 'Chosen'; name.dispatchEvent(new Event('input', { bubbles: true }))
  hex.value = '#ABCDEF80'; hex.dispatchEvent(new Event('input', { bubbles: true }))
  const excluded = document.querySelector<HTMLInputElement>('[data-merge-entry="1"]')!
  excluded.checked = false; excluded.dispatchEvent(new Event('change', { bubbles: true }))
  expect(name.value).toBe('Chosen'); expect(hex.value).toBe('#ABCDEF80')
  expect(document.querySelector<HTMLSelectElement>('#cleanup-survivor')!.value).toBe('2')
  expect(control.dialog.querySelector('[data-cleanup-warning]')!.textContent).toContain('cannot be undone')
  control.reject()
  await click('[data-cleanup-merge]')
  await vi.waitFor(() => expect(control.dialog.textContent).toContain('Review changed'))
  await click('[data-cleanup-refresh]')
  expect(name.value).toBe('Chosen'); expect(hex.value).toBe('#ABCDEF80')
  expect(control.commands[0].url).toBe('/api/v1/colors/combine')
  expect(control.commands[0].body.records.map(x => x.id)).toEqual(items.slice(1).map(x => x.id))
  await click('[data-dialog-close]')
  expect(control.commands).toHaveLength(1)
})

it('closes a successful selected merge and blocks missing sources or invalid result HEX', async () => {
  const items = [{ ...item(1), hex_code: 'legacy invalid' }, { ...item(2), hex_code: '#FF0000' }]
  const control = await setup(items, [])
  await click('#color-select-matching'); await click('#color-merge-selected')
  const submit = document.querySelector<HTMLButtonElement>('[data-cleanup-merge]')!
  expect(submit.disabled).toBe(true)
  const hex = document.querySelector<HTMLInputElement>('#cleanup-hex')!
  hex.value = '#abc8'; hex.dispatchEvent(new Event('input', { bubbles: true }))
  expect(submit.disabled).toBe(false)
  await click('[data-cleanup-merge]')
  await vi.waitFor(() => expect(control.reload).toHaveBeenCalledOnce())
  expect(control.dialog.open).toBe(false)
  expect(control.getSelectedIds()).toEqual([])
  await click('#color-select-matching')
  items.pop()
  await click('#color-merge-selected')
  expect(control.dialog.querySelector('[role="alert"]')!.textContent).toContain('removed')
  expect(document.querySelector<HTMLFormElement>('[data-cleanup-merge-form]')!.hidden).toBe(true)
})

it('gates fewer than two included colors and cancels/reopens without duplicate wheel controls', async () => {
  const control = await setup([item(1), { ...item(2), hex_code: '#FF000080' }], [])
  await click('#color-select-matching'); await click('#color-merge-selected')
  const count = control.dialog.querySelectorAll('[data-wheel-color]').length
  const first = document.querySelector<HTMLInputElement>('[data-merge-entry="1"]')!
  first.checked = false; first.dispatchEvent(new Event('change', { bubbles: true }))
  expect(document.querySelector<HTMLButtonElement>('[data-cleanup-merge]')!.disabled).toBe(true)
  await click('[data-cleanup-merge]')
  expect(control.commands).toHaveLength(0)
  await click('[data-dialog-close]')
  await click('#color-merge-selected')
  expect(control.dialog.querySelectorAll('[data-wheel-color]')).toHaveLength(count)
  expect(document.querySelector<HTMLButtonElement>('[data-cleanup-merge]')!.disabled).toBe(false)
  await click('[data-dialog-close]')
  expect(control.commands).toHaveLength(0)
})

it('requires a valid result or explicit RGB choice before opacity can replace a legacy HEX', async () => {
  const control = await setup([{ ...item(1), hex_code: 'legacy invalid' }, item(2)], [])
  await click('#color-select-matching'); await click('#color-merge-selected')
  const opacity = document.querySelector<HTMLInputElement>('#cleanup-alpha-enabled')!
  opacity.click()
  expect(document.querySelector<HTMLInputElement>('#cleanup-hex')!.value).toBe('legacy invalid')
  expect(opacity.disabled).toBe(true)
  expect(document.querySelector<HTMLButtonElement>('[data-cleanup-merge]')!.disabled).toBe(true)
  const rgb = document.querySelector<HTMLInputElement>('#cleanup-picker')!
  rgb.value = '#123456'; rgb.dispatchEvent(new Event('input', { bubbles: true }))
  expect(opacity.disabled).toBe(false)
  expect(document.querySelector<HTMLInputElement>('#cleanup-hex')!.value).toBe('#123456')
  expect(control.commands).toHaveLength(0)
})

it('keeps a draft accessible after a source is deleted and tells the user to reselect', async () => {
  const items = [item(1), item(2), item(3)]
  const control = await setup(items, [])
  await click('#color-select-matching'); await click('#color-merge-selected')
  const name = document.querySelector<HTMLInputElement>('#cleanup-name')!
  const hex = document.querySelector<HTMLInputElement>('#cleanup-hex')!
  name.value = 'Keep my result'; name.dispatchEvent(new Event('input', { bubbles: true }))
  hex.value = '#12345680'; hex.dispatchEvent(new Event('input', { bubbles: true }))
  items.pop(); control.reject()
  await click('[data-cleanup-merge]')
  await vi.waitFor(() => expect(control.dialog.textContent).toContain('Review changed'))
  await click('[data-cleanup-refresh]')
  expect(document.querySelector<HTMLFormElement>('[data-cleanup-merge-form]')!.hidden).toBe(false)
  expect(name.value).toBe('Keep my result'); expect(hex.value).toBe('#12345680')
  expect(document.querySelector<HTMLButtonElement>('[data-cleanup-merge]')!.disabled).toBe(true)
  expect(control.dialog.querySelector('[role="alert"]')!.textContent).toContain('select colors again')
  await click('[data-cleanup-merge]')
  expect(control.commands).toHaveLength(1)
  expect(control.commands[0].body.records.map(x => x.id)).toEqual([1, 2, 3])
})


it('keeps the draft available and blocks merge through repeated failed review refreshes', async () => {
  const control = await setup([item(1), item(2)], [])
  await click('#color-select-matching'); await click('#color-merge-selected')
  const form = control.dialog.querySelector<HTMLFormElement>('[data-cleanup-merge-form]')!
  const name = form.querySelector<HTMLInputElement>('#cleanup-name')!
  const hex = form.querySelector<HTMLInputElement>('#cleanup-hex')!
  const merge = form.querySelector<HTMLButtonElement>('[data-cleanup-merge]')!
  name.value = 'My result'; name.dispatchEvent(new Event('input', { bubbles: true }))
  hex.value = '#12345680'; hex.dispatchEvent(new Event('input', { bubbles: true }))
  control.reject()
  await click('[data-cleanup-merge]')
  await vi.waitFor(() => expect(control.dialog.textContent).toContain('Review changed'))
  control.setRefreshOffline(true)
  for (let attempt = 0; attempt < 2; attempt++) {
    await click('[data-cleanup-refresh]')
    expect(control.dialog.querySelector('[role="alert"]')!.textContent).toBe('Failed to load colors')
    expect(form.hidden).toBe(false)
    expect(name.value).toBe('My result')
    expect(hex.value).toBe('#12345680')
    expect(merge.disabled).toBe(true)
  }
  control.setRefreshOffline(false)
  await click('[data-cleanup-refresh]')
  expect(name.value).toBe('My result')
  expect(hex.value).toBe('#12345680')
  expect(merge.disabled).toBe(false)
  expect(control.commands).toHaveLength(1)
})
