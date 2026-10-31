// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { createSpoolProfilePicker } from './filament-spool-profile'
const profile = { id: 735, name: 'Cardboard reel', empty_weight_g: 170, spool_material: 'Cardboard', outer_diameter_mm: 200, width_mm: 68, image_file: '735.png' }
function setup() {
  document.body.innerHTML = `<form><input name="default_spool_weight_g" value="170"><select name="spool_material"><option>Cardboard</option></select><input name="spool_outer_diameter_mm" value="200"><input name="spool_width_mm" value="68"><div id="filament-spool-profile" hidden><button class="spool-profile-choose" type="button">Choose</button><span role="status"></span><span class="spool-profile-preview"></span><button class="spool-profile-clear" type="button">Clear</button><div class="spool-profile-lookup" hidden></div></div></form>`
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ items: [profile], total: 1 }), { status: 200 })))
  const change = vi.fn()
  const form = document.querySelector('form')!
  return { form, change, picker: createSpoolProfilePicker(form, change) }
}
afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = '' })
it('immediately clears the parent link on explicit rematch while loading', async () => {
  const { picker, form, change } = setup()
  let finish!: (value: Response) => void
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { finish = resolve })))
  picker.setLink(735, '735.png')
  const loading = picker.load()
  form.querySelector<HTMLInputElement>('[name="default_spool_weight_g"]')!.value = '164'
  form.querySelector<HTMLButtonElement>('.spool-profile-clear')!.click()
  expect(change).toHaveBeenLastCalledWith(null, null)
  expect(form.querySelector('img')).toBeNull()
  finish(Response.json({ items: [profile], total: 1 }))
  await loading
  expect(change).toHaveBeenLastCalledWith(null, null)
  picker.destroy()
})
it('infers a unique manual profile, clears a nonmatching inferred link, and leaves measured values alone', async () => {
  const { picker, form, change } = setup()
  await picker.load()
  picker.setLink(null, null)
  picker.match()
  expect(change).toHaveBeenLastCalledWith(735, '735.png')
  expect(form.querySelector('img')?.getAttribute('src')).toContain('735.png')
  form.querySelector<HTMLInputElement>('[name="default_spool_weight_g"]')!.value = '164'
  picker.match()
  expect(change).toHaveBeenLastCalledWith(null, null)
  expect(form.querySelector<HTMLInputElement>('[name="default_spool_weight_g"]')!.value).toBe('164')
  picker.destroy()
})
it('retains saved explicit links when a user measures a different empty weight', async () => {
  const { picker, form, change } = setup()
  await picker.load()
  picker.setLink(735, '735.png')
  form.querySelector<HTMLInputElement>('[name="default_spool_weight_g"]')!.value = '164'
  picker.match()
  expect(change).not.toHaveBeenCalled()
  expect(form.querySelector('img')?.getAttribute('src')).toContain('735.png')
  picker.destroy()
})
it('supports explicit selection with thumbnails and applying defaults only on selection', async () => {
  const { picker, form, change } = setup()
  await picker.load()
  form.querySelector<HTMLButtonElement>('.spool-profile-choose')!.click()
  const search = form.querySelector<HTMLInputElement>('.fdb-lookup-input')!
  search.dispatchEvent(new FocusEvent('focus'))
  await vi.waitFor(() => expect(form.querySelector('.fdb-lookup-item')).not.toBeNull())
  expect(form.querySelector('.fdb-lookup-item img')).not.toBeNull()
  expect(form.querySelector('.fdb-lookup-item')!.tagName).toBe('BUTTON')
  expect(form.querySelector<HTMLButtonElement>('.fdb-lookup-item')!.type).toBe('button')
  form.querySelector<HTMLElement>('.fdb-lookup-item')!.click()
  expect(change).toHaveBeenLastCalledWith(735, '735.png')
  expect(form.querySelector<HTMLInputElement>('[name="default_spool_weight_g"]')!.value).toBe('170')
  form.querySelector<HTMLButtonElement>('.spool-profile-clear')!.click()
  expect(change).toHaveBeenLastCalledWith(735, '735.png')
  picker.destroy()
})
it('retains a saved image when catalog loading fails and after teardown', async () => {
  const { picker, form, change } = setup()
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
  await picker.load()
  picker.setLink(735, '735.png')
  expect(form.querySelector('img')).not.toBeNull()
  expect(change).not.toHaveBeenCalled()
  picker.destroy()
})
it('shows the saved selection during an outage instead of hiding its ancestor', async () => {
  const { picker, form } = setup()
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
  await picker.load()
  picker.setLink(735, '735.png')
  expect(form.querySelector<HTMLElement>('#filament-spool-profile')!.hidden).toBe(false)
  expect(form.querySelector<HTMLButtonElement>('.spool-profile-choose')!.disabled).toBe(true)
  picker.destroy()
})
it('matches manual values entered while catalog loading is pending', async () => {
  const { picker, change } = setup()
  let finish!: (value: Response) => void
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { finish = resolve })))
  const loading = picker.load()
  picker.match()
  finish(new Response(JSON.stringify({ items: [profile], total: 1 })))
  await loading
  expect(change).toHaveBeenLastCalledWith(735, '735.png')
  picker.destroy()
})
