// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { initPerModelProfilePicker } from './cloud-profile-picker'
import { setLang, t } from './i18n'

afterEach(() => { document.body.innerHTML = ''; vi.unstubAllGlobals(); vi.restoreAllMocks() })
async function profileFixture(status: 'ok' | 'fallback' | 'not_set' | 'missing', readOnly = true, options: { override?: boolean; failWrite?: boolean; onSaved?: () => Promise<void>; onSavingChange?: (saving: boolean) => void } = {}) {
  setLang('en')
  document.body.innerHTML = '<section id="slicer-profile-section" class="hidden"><div id="slicer-profile-picker"></div><div id="slicer-profile-coverage"></div><p id="slicer-profile-msg"></p></section>'
  let selected = 'Generic PLA'
  const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const path = String(input)
    if (init?.method === 'POST' && path.includes('/slicer-profile/')) {
      if (options.failWrite) return Response.json({ detail: { message: 'Profile rejected' } }, { status: 422 })
      selected = JSON.parse(String(init.body)).base_name
      return Response.json({ base_name: selected })
    }
    if (path === '/api/v1/printers') return Response.json({ items: [{ id: 1, driver_key: 'bambuddy' }, { id: 2, driver_key: 'bambuddy' }] })
    if (path.endsWith('/health')) return Response.json({ connected: true })
    if (path.endsWith('/connected-models')) return Response.json({ models: [{ model: 'X1C', printer_ids: [1, 2], representative_printer_id: 1 }] })
    if (path.includes('/profile-coverage')) return Response.json({ default_base_name: selected, profiles_by_model: { X1C: { base_name: selected, source: options.override ? 'override' : 'default' } }, coverage: { X1C: { status, mapped: status !== 'not_set', base_name: selected, ...(status === 'not_set' ? {} : { nozzle_requested: 0.6, nozzle_resolved: status === 'fallback' ? 0.4 : 0.6, fallback_nozzle: status === 'fallback', exact_nozzle: status === 'ok' }) } } })
    if (path.includes('/cloud-presets')) return Response.json({ presets: ['Generic PLA', 'Matte PLA'].map(baseName => ({ baseName, displayName: baseName, model: 'X1C' })) })
    throw new Error(`Unexpected ${path}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  await initPerModelProfilePicker({ entityType: 'filament', entityId: 3, t, getCsrfToken: () => 'csrf', getAbortSignal: () => undefined, isAbortError: () => false, readOnly, onSaved: options.onSaved, onSavingChange: options.onSavingChange })
  return { picker: document.getElementById('slicer-profile-picker')!, fetchMock }
}

describe('profile presentation in printer setup', () => {
  it('shows the correct nozzle profile name when the cloud variant is missing', async () => {
    const { picker } = await profileFixture('missing')
    expect(picker.querySelector('.profile-picker-cloud-line')!.textContent).toContain('Generic PLA @BBL X1C 0.6 nozzle')
  })
  it('shows a single model for shared physical printers without exposing write controls to viewers', async () => {
    const { picker } = await profileFixture('ok')
    expect(picker.textContent).toContain('X1C')
    expect(picker.textContent).toContain('Generic PLA')
    expect(picker.querySelectorAll('[data-model="X1C"]')).toHaveLength(1)
    expect(picker.querySelector('input, button, select')).toBeNull()
  })
  it('keeps fallback and unknown nozzle information honest', async () => {
    const fallback = await profileFixture('fallback')
    expect(fallback.picker.textContent).toContain('closest available')
    const unknown = await profileFixture('not_set')
    expect(unknown.picker.textContent).not.toContain('exact match')
  })
  it('retains default and model profile editing for users with write access', async () => {
    const { picker } = await profileFixture('ok', false)
    expect(picker.querySelector('.default-profile-combo')).not.toBeNull()
    expect(picker.querySelectorAll('.per-model-profile-row')).toHaveLength(1)
    expect(picker.querySelectorAll('.per-model-profile-row .profile-std-nozzles')).toHaveLength(1)
    expect(picker.querySelector('button')).not.toBeNull()
  })
  it.each(['default', 'model'] as const)('%s dropdown filters, saves and preserves retry controls after rejection', async target => {
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    for (const failWrite of [false, true]) {
      const { picker, fetchMock } = await profileFixture('ok', false, { override: target === 'model', failWrite })
      const combo = picker.querySelector<HTMLElement>(target === 'default' ? '.default-profile-combo' : '.per-model-combo')!
      const search = combo.querySelector<HTMLInputElement>('.cloud-combo-search')!
      search.value = 'matte'
      search.dispatchEvent(new Event('input'))
      expect(combo.querySelectorAll('.cloud-combo-opt')).toHaveLength(1)
      expect(combo.querySelector('.cloud-combo-opt')!.textContent).toBe('Matte PLA')
      combo.querySelector('.cloud-combo-opt')!.dispatchEvent(new MouseEvent('mousedown', { cancelable: true }))
      await vi.waitFor(() => expect(document.getElementById('slicer-profile-msg')!.textContent).toContain(failWrite ? 'Profile rejected' : 'Saved'))
      const write = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')!
      expect(write[0]).toBe(`/api/v1/filaments/3/slicer-profile/${target === 'default' ? 'default' : 'models/X1C'}`)
      expect(JSON.parse(String(write[1]!.body)).base_name).toBe('Matte PLA')
      expect(search.value).toBe('Matte PLA')
      expect(search.disabled).toBe(false)
    }
  })

})


it('keeps a committed profile busy until the caller has reconciled it', async () => {
  vi.spyOn(window, 'confirm').mockReturnValue(false)
  let busy = false, release!: () => void
  const { picker } = await profileFixture('ok', false, {
    onSavingChange: saving => { busy = saving },
    onSaved: () => new Promise<void>(resolve => { release = resolve }),
  })
  const combo = picker.querySelector<HTMLElement>('.default-profile-combo')!
  const search = combo.querySelector<HTMLInputElement>('.cloud-combo-search')!
  search.value = 'matte'
  search.dispatchEvent(new Event('input'))
  combo.querySelector('.cloud-combo-opt')!.dispatchEvent(new MouseEvent('mousedown', { cancelable: true }))
  await vi.waitFor(() => expect(release).toBeDefined())
  expect(busy).toBe(true)
  expect(document.getElementById('slicer-profile-msg')!.textContent).not.toContain('Saved')
  release()
  await vi.waitFor(() => expect(document.getElementById('slicer-profile-msg')!.textContent).toContain('Saved'))
  expect(busy).toBe(false)
})
