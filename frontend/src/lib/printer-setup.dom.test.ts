// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getMe } from './auth'
import { initPrinterSetup } from './printer-setup'
import { initPerModelProfilePicker } from './cloud-profile-picker'
import { setLang, t } from './i18n'
import type { SystemExtraFieldDef } from './extra-fields'

vi.mock('./auth', async importOriginal => ({ ...await importOriginal<typeof import('./auth')>(), getMe: vi.fn() }))
vi.mock('./cloud-profile-picker', () => ({ initPerModelProfilePicker: vi.fn(async () => 1) }))
const controllers: ReturnType<typeof initPrinterSetup>[] = []
afterEach(() => { controllers.splice(0).forEach(c => c.dispose()); document.body.innerHTML = ''; vi.unstubAllGlobals(); vi.clearAllMocks() })

async function setup(options: { entityType?: 'spool' | 'filament'; readonly?: boolean; permissions?: string[]; noPrinters?: boolean; inactivePlugin?: boolean; range?: boolean; sameDriver?: boolean; editing?: boolean; noDefinitions?: boolean } = {}) {
  setLang('en')
  vi.mocked(getMe).mockResolvedValue({ is_superadmin: false, permissions: options.permissions ?? (options.readonly ? ['spools:read', 'filaments:read'] : ['spools:update', 'filaments:update', 'admin:plugins_manage', 'printers:update']) } as Awaited<ReturnType<typeof getMe>>)
  let printers = options.noPrinters ? [] : [{ id: 1, name: 'Printer One', driver_key: 'bambuddy', is_active: true }, { id: 2, name: 'Printer Two', driver_key: options.sameDriver ? 'bambuddy' : 'other', is_active: true }]
  const own: Record<string, string | null> = { bambu_nozzle_temp_min: '210', bambu_setting_id: 'PFUS1' }
  const parent: Record<string, string | null> = { bambu_nozzle_temp_min: '205', bambu_k_value: '0.025', zero: '0', sealed: 'false' }
  const definitions: SystemExtraFieldDef[] = [
    { key: 'bambu_nozzle_temp_min', label: 'Nozzle minimum', field_type: 'number' },
    { key: 'bambu_k_value', label: 'Pressure advance K', field_type: 'number' },
    { key: 'zero', label: 'Zero', field_type: 'number' },
    { key: 'sealed', label: 'Sealed', field_type: 'checkbox' },
    { key: 'legacy', label: 'Legacy blank', field_type: 'text' },
    { key: 'bambu_setting_id', label: 'Profile ID', field_type: 'text' },
    { key: 'bambu_default_nozzle_mm', label: 'Default Nozzle Diameter (mm)', field_type: 'number' },
    { key: 'bambu_max_volumetric_speed', label: 'Max Volumetric Speed', field_type: 'number' },
  ]
  if (options.range) {
    definitions.find(field => field.key === 'bambu_nozzle_temp_min')!.config = { min_bound: 0, max_bound: 400 }
    definitions.push({ key: 'bambu_nozzle_temp_max', label: 'Nozzle maximum', field_type: 'number', config: { min_bound: 0, max_bound: 400 } })
    parent.bambu_nozzle_temp_max = '225'
  }
  let failDelete = false
  const calls: { path: string; method: string; body?: { params: { param_key: string; param_value: string }[] } }[] = []
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url)
    const method = init?.method || 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ path, method, body })
    if (method === 'GET' && path.startsWith('/api/v1/printers?')) return Response.json({ items: printers, total: printers.length })
    if (path === '/api/v1/admin/system/plugins') return Response.json([{ name: 'Bambuddy', driver_key: 'bambuddy', is_active: !options.inactivePlugin }])
    if (path.includes('/parameter-fields?')) return Response.json(options.noDefinitions || (path.includes('/printers/2/') && !options.sameDriver) ? [] : definitions)
    if (method === 'PUT') {
      for (const param of body.params) own[param.param_key] = param.param_value
      return Response.json(body.params)
    }
    if (method === 'DELETE') {
      if (failDelete) return Response.json({ detail: 'Delete refused' }, { status: 403 })
      delete own[new URL(path, 'http://localhost').searchParams.get('param_key')!]
      return new Response(null, { status: 204 })
    }
    if (path.includes('/printer-params?printer_id=2')) return Response.json(options.sameDriver && path.startsWith('/api/v1/filaments') ? [{ param_key: 'bambu_k_value', param_value: '0.035' }] : [])
    if (path.includes('/printer-params?')) {
      const values = options.entityType === 'filament' || path.startsWith('/api/v1/spools') ? own : parent
      return Response.json(Object.entries(values).map(([param_key, param_value]) => ({ param_key, param_value })))
    }
    throw new Error(`Unexpected ${method} ${path}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  const mount = document.createElement('section'); mount.className = 'printer-setup hidden'; document.body.appendChild(mount)
  const controller = initPrinterSetup({ mount, entityType: options.entityType || 'spool', entityId: 17, filamentId: 3, filamentLabel: 'PLA Basic', t, getCsrfToken: () => 'csrf', editing: options.editing ?? true })
  controllers.push(controller)
  await controller.ready
  const field = (key: string) => mount.querySelector<HTMLElement>(`[data-parameter="${key}"]`)!
  const action = (key: string, name: string) => field(key).querySelector<HTMLButtonElement>(`[data-setup-action="${name}"]`)!
  const input = (key: string) => field(key).querySelector<HTMLInputElement>('input')!
  const change = (key: string, value: string | boolean) => {
    const control = input(key)
    if (typeof value === 'boolean') control.checked = value
    else control.value = value
    control.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const expandPrinter = async (id: number) => {
    const panel = mount.querySelector<HTMLDetailsElement>(`[data-printer-id="${id}"]`)!
    panel.open = true
    panel.dispatchEvent(new Event('toggle'))
    await vi.waitFor(() => expect(mount.querySelector(`[data-printer-id="${id}"] [data-parameter]`)).not.toBeNull())
  }
  return { mount, controller, own, parent, calls, field, action, input, change, expandPrinter, removePrinters: () => { printers = [] }, refuseDelete: (value: boolean) => { failDelete = value } }
}

describe('shared printer setup', () => {
  it.each(['filament', 'spool'] as const)('loads collapsed %s printer cards on demand and keeps their drafts refreshed', async entityType => {
    const ui = await setup({ entityType, sameDriver: true })
    expect(ui.calls.filter(call => call.path.includes('/parameter-fields?'))).toHaveLength(1)
    expect(ui.mount.querySelector('[data-printer-id="2"] [data-setup-value]')).toBeNull()
    const second = ui.mount.querySelector<HTMLDetailsElement>('[data-printer-id="2"]')!
    second.open = true
    second.dispatchEvent(new Event('toggle'))
    second.dispatchEvent(new Event('toggle'))
    await vi.waitFor(() => expect(ui.mount.querySelector('[data-printer-id="2"] [data-setup-value="bambu_k_value"]')).not.toBeNull())
    expect(ui.calls.filter(call => call.path.includes('/printers/2/parameter-fields?'))).toHaveLength(1)
    const value = ui.mount.querySelector<HTMLInputElement>('[data-printer-id="2"] [data-setup-value="bambu_k_value"]')!
    value.value = '0.040'
    value.dispatchEvent(new Event('input', { bubbles: true }))
    ui.mount.querySelector<HTMLDetailsElement>('[data-printer-id="2"]')!.open = false
    await ui.controller.refresh()
    expect(ui.mount.querySelector<HTMLInputElement>('[data-printer-id="2"] [data-setup-value="bambu_k_value"]')!.value).toBe('0.040')
    expect(ui.controller.isDirty()).toBe(true)
    expect(ui.calls.filter(call => call.path.includes('/printers/2/parameter-fields?'))).toHaveLength(2)
  })

  it('leaves failed lazy loads for explicit retry instead of retrying when open details are rendered', async () => {
    const ui = await setup({ sameDriver: true })
    const fetchData = globalThis.fetch
    let fail = true
    let reads = 0
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('/printers/2/parameter-fields?')) {
        reads++
        if (fail) return Promise.resolve(Response.json({ detail: 'Offline' }, { status: 503 }))
      }
      return fetchData(input, init)
    })
    const second = ui.mount.querySelector<HTMLDetailsElement>('[data-printer-id="2"]')!
    second.open = true
    second.dispatchEvent(new Event('toggle'))
    await vi.waitFor(() => expect(ui.mount.querySelector('[data-printer-id="2"] [role="alert"]')?.textContent).toBe('Offline'))
    ui.mount.querySelector('[data-printer-id="2"]')!.dispatchEvent(new Event('toggle'))
    expect(reads).toBe(1)
    fail = false
    ui.mount.querySelector<HTMLButtonElement>('[data-printer-id="2"] [data-setup-action="retry"]')!.click()
    await vi.waitFor(() => expect(ui.mount.querySelector('[data-printer-id="2"] [data-parameter="bambu_k_value"]')).not.toBeNull())
    expect(reads).toBe(2)
  })

  it.each(['filament', 'spool'] as const)('allows a %s editor with only its seeded update permission to save', async entityType => {
    const ui = await setup({ entityType, permissions: [`${entityType}s:update`] })
    ui.change('bambu_k_value', '0.030')
    await ui.controller.save()
    expect(ui.own.bambu_k_value).toBe('0.030')
    expect(ui.controller.isDirty()).toBe(false)
  })
  it('separates model-scoped profiles from physical printers and links only the plugin from profile attribution', async () => {
    const ui = await setup({ inactivePlugin: true })
    const profiles = ui.mount.querySelector('#slicer-profile-section')!
    const printers = ui.mount.querySelector('[data-printer-settings]')!
    expect(profiles.contains(printers)).toBe(false)
    expect(printers.contains(profiles)).toBe(false)
    const attribution = profiles.querySelector('[data-profile-provider]')!
    expect(attribution.querySelector('use')?.getAttribute('href')).toBe('/icons.svg#icon-plugin')
    expect(attribution.querySelector('a[href="/admin/system"]')).not.toBeNull()
    expect(attribution.querySelector('a[href^="/printers/"]')).toBeNull()
    expect(printers.querySelector('a[href="/printers/1"]')?.getAttribute('aria-label')).toContain('Printer One')
    expect(printers.querySelector('.printer-setup-driver-label use')?.getAttribute('href')).toBe('/icons.svg#icon-plugin')
    expect(printers.textContent).toContain('Driver disabled')
  })
  it('uses empty dash placeholders while keeping the source-label element beneath inputs', async () => {
    const ui = await setup({ entityType: 'filament' })
    const nozzle = ui.field('bambu_default_nozzle_mm')
    expect(nozzle.querySelector('label')!.textContent).toBe('Fallback nozzle diameter')
    expect(nozzle.querySelector('.printer-setup-unit')!.textContent).toBe('mm')
    expect(ui.field('bambu_max_volumetric_speed').querySelector('.printer-setup-unit')!.textContent).toBe('mm³/s')
    expect(nozzle.querySelector('.printer-setup-entry .printer-setup-origin')!.textContent).toBe('')
    expect(nozzle.querySelector('input')!.getAttribute('placeholder')).toBe('—')
    expect(nozzle.querySelector('input')!.value).toBe('')
  })
  it('highlights differences rather than ownership while retaining reset for equal stored overrides', async () => {
    const ui = await setup()
    ui.parent.bambu_nozzle_temp_min = '210.0'
    await ui.controller.refresh()
    expect(ui.field('bambu_nozzle_temp_min').dataset.owned).toBe('false')
    expect(ui.action('bambu_nozzle_temp_min', 'reset').classList.contains('hidden')).toBe(false)
    ui.change('bambu_nozzle_temp_min', '215')
    expect(ui.field('bambu_nozzle_temp_min').dataset.owned).toBe('true')
    ui.action('bambu_nozzle_temp_min', 'reset').click()
    expect(ui.controller.isDirty()).toBe(true)
    await ui.controller.save()
    expect(ui.own.bambu_nozzle_temp_min).toBeUndefined()
    expect(ui.parent.bambu_nozzle_temp_min).toBe('210.0')
  })
  it('loads each printer declaration instead of filtering fields by global plugin ownership', async () => {
    const ui = await setup({ sameDriver: true })
    await ui.expandPrinter(2)
    expect(ui.mount.querySelectorAll('[data-parameter="bambu_k_value"]')).toHaveLength(2)
    expect(ui.calls.some(call => call.path === '/api/v1/printers/1/parameter-fields?target_type=spool_printer_param')).toBe(true)
    expect(ui.calls.some(call => call.path.includes('/system-extra-fields'))).toBe(false)
  })
  it('retains saved values as read-only when their plugin definitions are missing', async () => {
    const ui = await setup({ noDefinitions: true })
    expect(ui.field('bambu_nozzle_temp_min').textContent).toContain('210')
    expect(ui.field('bambu_nozzle_temp_min').querySelector('input')).toBeNull()
    expect(ui.field('bambu_nozzle_temp_min').closest('details')!.textContent).not.toContain('no editable printer parameters')
    await ui.controller.save()
    expect(ui.own.bambu_setting_id).toBe('PFUS1')
    expect(ui.calls.filter(call => call.method !== 'GET')).toEqual([])
  })
  it('keeps value origins beneath both populated and empty editable entries', async () => {
    const filament = await setup({ entityType: 'filament' })
    expect(filament.field('bambu_nozzle_temp_min').querySelector('.printer-setup-origin')!.textContent).toBe('Filament')
    expect(filament.field('bambu_default_nozzle_mm').querySelector('.printer-setup-origin')!.textContent).toBe('')
    const spool = await setup()
    expect(spool.field('bambu_k_value').querySelector('.printer-setup-origin')!.textContent).toBe('Filament')
    spool.change('bambu_k_value', '0.030')
    expect(spool.field('bambu_k_value').querySelector('.printer-setup-origin')!.textContent).toBe('Spool')
    spool.parent.bambu_nozzle_temp_min = '210'
    await spool.controller.refresh()
    expect(spool.field('bambu_nozzle_temp_min').querySelector('.printer-setup-origin')!.textContent).toBe('Spool')
  })
  it('marks only edited rows and clears the printer badge when the original value is restored', async () => {
    const ui = await setup()
    const badge = ui.field('bambu_k_value').closest('details')!.querySelector('[data-printer-dirty]')!
    ui.change('bambu_k_value', '0.030')
    expect(badge.textContent).toBe('Changed')
    expect(badge.classList.contains('hidden')).toBe(false)
    expect(ui.field('bambu_k_value').classList.contains('is-dirty')).toBe(true)
    expect(ui.field('bambu_nozzle_temp_min').classList.contains('is-dirty')).toBe(false)
    ui.change('bambu_k_value', '0.025')
    expect(badge.classList.contains('hidden')).toBe(true)
    expect(ui.field('bambu_k_value').classList.contains('is-dirty')).toBe(false)
  })
  it('uses page Edit, Save and Cancel without storing unchanged inherited values', async () => {
    const ui = await setup()
    await ui.controller.setEditing(false)
    expect(ui.mount.querySelector('[data-setup-value]')).toBeNull()
    await ui.controller.setEditing(true)
    expect(ui.input('bambu_k_value').value).toBe('0.025')
    expect(ui.mount.querySelector('[data-setup-action="customize"], [data-setup-action="save"]')).toBeNull()
    await ui.controller.save()
    expect(ui.calls.filter(c => c.method !== 'GET')).toEqual([])
    ui.input('bambu_k_value').value = '0.030'
    ui.input('bambu_k_value').dispatchEvent(new Event('input', { bubbles: true }))
    expect(ui.controller.isDirty()).toBe(true)
    await ui.controller.setEditing(false)
    expect(ui.controller.isDirty()).toBe(false)
    expect(ui.field('bambu_k_value').textContent).toContain('0.025')
    await ui.controller.setEditing(true)
    ui.input('bambu_k_value').value = '0.030'
    ui.input('bambu_k_value').dispatchEvent(new Event('input', { bubbles: true }))
    await ui.controller.save()
    expect(ui.own.bambu_k_value).toBe('0.030')
    expect(ui.controller.isDirty()).toBe(false)
  })
  it('removes profile mutation controls synchronously when leaving Edit', async () => {
    const ui = await setup()
    const picker = ui.mount.querySelector('#slicer-profile-picker')!
    picker.innerHTML = '<button type="button">Apply profile</button>'
    let complete!: () => void
    vi.mocked(initPerModelProfilePicker).mockImplementationOnce(() => new Promise<number>(resolve => { complete = () => resolve(1) }))
    const pending = ui.controller.setEditing(false)
    expect(picker.querySelector('button')).toBeNull()
    expect(ui.mount.querySelector<HTMLFieldSetElement>('[data-profile-controls]')!.disabled).toBe(true)
    await vi.waitFor(() => expect(complete).toBeDefined())
    complete(); await pending
  })
  it('updates saved parent context before retrying a partially saved spool reassignment', async () => {
    const ui = await setup()
    ui.change('bambu_k_value', '0.030')
    await expect(ui.controller.save(async () => {
      ui.parent.bambu_k_value = '0.045'
      await ui.controller.setFilament(4, 'New parent')
    })).rejects.toThrow()
    expect(ui.mount.querySelector('a[href="/filaments/4"]')?.getAttribute('title')).toContain('New parent')
    expect(ui.field('bambu_k_value').textContent).toContain('0.045')
    expect(ui.calls.filter(c => c.method !== 'GET')).toEqual([])
    ui.action('bambu_k_value', 'keep').click()
    await ui.controller.save()
    expect(ui.own.bambu_k_value).toBe('0.030')
  })
  it('keeps technical IDs collapsed while ordinary values stay visible, preserving accordion state', async () => {
    const ui = await setup({ sameDriver: true })
    const technical = ui.mount.querySelector<HTMLDetailsElement>('.printer-setup-additional')!
    expect(technical.querySelector('[data-parameter="bambu_setting_id"]')).not.toBeNull()
    expect(technical.querySelector('[data-parameter="bambu_default_nozzle_mm"]')).toBeNull()
    technical.open = true
    ui.action('bambu_nozzle_temp_min', 'reset').click()
    expect(ui.mount.querySelector<HTMLDetailsElement>('.printer-setup-additional')!.open).toBe(true)
    const printers = ui.mount.querySelectorAll<HTMLDetailsElement>('.printer-setup-printer')
    expect(printers).toHaveLength(2)
    printers[0].open = false
    await ui.controller.refresh()
    expect(ui.mount.querySelector<HTMLDetailsElement>('.printer-setup-printer')!.open).toBe(false)
  })
  it('renders a bounded nozzle range and resets only its owned endpoints', async () => {
    const ui = await setup({ range: true })
    const range = ui.field('nozzle-range')
    expect(range.querySelectorAll('input')).toHaveLength(2)
    expect(range.querySelector<HTMLInputElement>('input')!.min).toBe('0')
    expect(range.querySelector<HTMLInputElement>('input')!.max).toBe('400')
    range.querySelector<HTMLButtonElement>('[data-setup-action="range-reset"]')!.click()
    await ui.controller.save()
    expect(ui.own.bambu_nozzle_temp_min).toBeUndefined()
    expect(ui.calls.filter(c => c.method === 'DELETE')).toHaveLength(1)
    expect(ui.own.bambu_setting_id).toBe('PFUS1')
  })
  it('keeps calibration independent for physical printers sharing a driver', async () => {
    const ui = await setup({ sameDriver: true })
    await ui.expandPrinter(2)
    ui.change('bambu_k_value', '0.030')
    expect(ui.mount.querySelector<HTMLInputElement>('[data-printer-id="2"] [data-setup-value="bambu_k_value"]')!.value).toBe('0.035')
    await ui.controller.save()
    expect(ui.calls.filter(c => c.method === 'PUT').map(c => c.path)).toEqual(['/api/v1/spools/17/printer-params/1'])
  })
  it('reverts inherited edits without storing copies, while preserving explicit false values', async () => {
    const ui = await setup()
    ui.change('zero', '5'); ui.change('zero', '0')
    expect(ui.controller.isDirty()).toBe(false)
    ui.change('sealed', true); await ui.controller.save()
    ui.change('sealed', false); await ui.controller.save()
    expect(ui.own.sealed).toBe('false')
    expect(ui.own.bambu_setting_id).toBe('PFUS1')
  })
  it('retains failed deletes for retry and keeps only the unsaved portion after partial success', async () => {
    const ui = await setup()
    ui.change('bambu_k_value', '0.030')
    ui.action('bambu_nozzle_temp_min', 'reset').click()
    ui.refuseDelete(true)
    await expect(ui.controller.save()).rejects.toThrow('Delete refused')
    expect(ui.own.bambu_k_value).toBe('0.030')
    expect(ui.own.bambu_nozzle_temp_min).toBe('210')
    expect(ui.controller.isDirty()).toBe(true)
    ui.refuseDelete(false)
    await ui.controller.save()
    expect(ui.own.bambu_nozzle_temp_min).toBeUndefined()
    expect(ui.controller.isDirty()).toBe(false)
    expect(ui.calls.filter(c => c.method === 'PUT')).toHaveLength(1)
  })
  it('validates every input before invoking the entity save', async () => {
    const ui = await setup({ range: true })
    const input = ui.mount.querySelector<HTMLInputElement>('[data-setup-value="bambu_nozzle_temp_max"]')!
    input.value = '500'; input.dispatchEvent(new Event('input', { bubbles: true }))
    const entitySave = vi.fn(async () => {})
    await expect(ui.controller.save(entitySave)).rejects.toThrow()
    expect(entitySave).not.toHaveBeenCalled()
    expect(ui.calls.filter(c => c.method !== 'GET')).toEqual([])
  })
  it('blocks mode changes as soon as Save starts, including while initialization is pending', async () => {
    const ui = await setup()
    const pending = ui.controller.save(async () => { throw new Error('Entity failed') })
    void pending.catch(() => {})
    expect(ui.controller.isSaving()).toBe(true)
    await ui.controller.setEditing(false)
    await expect(pending).rejects.toThrow('Entity failed')
    expect(ui.mount.querySelector('[data-setup-value]')).not.toBeNull()
  })
  it('lets the page own explicit Cancel without a navigation prompt or premature draft reset', async () => {
    const ui = await setup()
    ui.change('bambu_k_value', '0.030')
    const confirm = vi.fn(() => false)
    vi.stubGlobal('confirm', confirm)
    const cancel = document.createElement('a')
    cancel.href = '/filaments/17'; cancel.dataset.discardPrinterDraft = 'true'
    ui.mount.appendChild(cancel)
    const click = new MouseEvent('click', { bubbles: true, cancelable: true })
    cancel.dispatchEvent(click)
    expect(confirm).not.toHaveBeenCalled()
    expect(click.defaultPrevented).toBe(false)
    expect(ui.controller.isDirty()).toBe(true)
    await ui.controller.setEditing(false)
    expect(ui.controller.isDirty()).toBe(false)
  })
  it('keeps printer drafts when entity save fails and freezes controls during submission', async () => {
    const ui = await setup()
    ui.change('bambu_k_value', '0.030')
    await expect(ui.controller.save(async () => {
      expect(ui.mount.querySelector('[data-setup-value]')).toBeNull()
      const cancel = document.createElement('a')
      cancel.href = '/filaments/17'; cancel.dataset.discardPrinterDraft = 'true'
      ui.mount.appendChild(cancel)
      const click = new MouseEvent('click', { bubbles: true, cancelable: true })
      cancel.dispatchEvent(click)
      expect(click.defaultPrevented).toBe(true)
      throw new Error('Entity failed')
    })).rejects.toThrow('Entity failed')
    expect(ui.input('bambu_k_value').value).toBe('0.030')
    expect(ui.controller.isDirty()).toBe(true)
    expect(ui.calls.filter(c => c.method !== 'GET')).toEqual([])
  })
  it('preserves unrelated drafts across imports and requires resolving overlapping changes', async () => {
    const ui = await setup()
    ui.change('bambu_k_value', '0.030')
    ui.own.bambu_nozzle_temp_min = '215'; await ui.controller.refresh()
    expect(ui.input('bambu_k_value').value).toBe('0.030')
    ui.own.bambu_k_value = '0.040'; await ui.controller.refresh()
    await expect(ui.controller.save()).rejects.toThrow()
    ui.action('bambu_k_value', 'keep').click(); await ui.controller.save()
    expect(ui.own.bambu_k_value).toBe('0.030')
  })
  it('detects a changed parent underneath a spool draft', async () => {
    const ui = await setup()
    ui.change('bambu_k_value', '0.030')
    ui.parent.bambu_k_value = '0.035'; await ui.controller.refresh()
    await expect(ui.controller.save()).rejects.toThrow()
    ui.action('bambu_k_value', 'updated').click()
    expect(ui.input('bambu_k_value').value).toBe('0.035')
    expect(ui.controller.isDirty()).toBe(false)
  })
  it.each(['list', 'parameters'] as const)('waits for an active %s refresh before checking conflicts and saving the entity', async phase => {
    const ui = await setup()
    ui.change('bambu_k_value', '0.030')
    ui.own.bambu_k_value = '0.040'
    const fetchData = globalThis.fetch
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    let intercepted = false
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      if (!intercepted && (phase === 'list' ? path.includes('/printers?') : path.includes('/spools/17/printer-params?'))) {
        intercepted = true
        await held
      }
      return fetchData(input, init)
    })
    const refresh = ui.controller.refresh()
    await vi.waitFor(() => expect(intercepted).toBe(true))
    let entitySaved = false
    const result = ui.controller.save(async () => { entitySaved = true }).then(() => 'saved', error => String(error))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(entitySaved).toBe(false)
    release()
    await refresh
    expect(await result).toContain(t('printerSetup.resolveBeforeSave'))
    expect(entitySaved).toBe(false)
    expect(ui.own.bambu_k_value).toBe('0.040')
    expect(ui.controller.isDirty()).toBe(true)
  })

  it('blocks main Save and mode changes until an immediate profile write finishes', async () => {
    const ui = await setup()
    const picker = vi.mocked(initPerModelProfilePicker).mock.calls.at(-1)![0]
    picker.onSavingChange?.(true)
    expect(ui.controller.isSaving()).toBe(true)
    await expect(ui.controller.save()).rejects.toThrow(t('printerSetup.resolveBeforeSave'))
    await ui.controller.setEditing(false)
    expect(ui.input('bambu_k_value')).not.toBeNull()
    picker.onSavingChange?.(false)
    expect(ui.controller.isSaving()).toBe(false)
    await ui.controller.setEditing(false)
    expect(ui.field('bambu_k_value').querySelector('input')).toBeNull()
  })

  it('rejects a new profile write while Save is waiting for discovery', async () => {
    const ui = await setup()
    const picker = vi.mocked(initPerModelProfilePicker).mock.calls.at(-1)![0]
    const fetchData = globalThis.fetch
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('/printers?')) await held
      return fetchData(input, init)
    })
    const refreshing = ui.controller.refresh()
    const saving = ui.controller.save()
    expect(ui.mount.querySelector<HTMLFieldSetElement>('[data-profile-controls]')!.disabled).toBe(true)
    expect(() => picker.onSavingChange?.(true)).toThrow(t('printerSetup.resolveBeforeSave'))
    release()
    await refreshing
    await saving
    expect(ui.controller.isSaving()).toBe(false)
    expect(ui.mount.querySelector<HTMLFieldSetElement>('[data-profile-controls]')!.disabled).toBe(false)
  })

  it('retries failed printer discovery on the next Save without losing the draft', async () => {
    const ui = await setup()
    ui.change('bambu_k_value', '0.030')
    const fetchData = globalThis.fetch
    let offline = true
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => offline && String(input).includes('/printers?')
      ? Promise.resolve(Response.json({ detail: 'Discovery offline' }, { status: 503 }))
      : fetchData(input, init))
    await ui.controller.refresh()
    await expect(ui.controller.save()).rejects.toThrow(t('printerSetup.resolveBeforeSave'))
    expect(ui.controller.isDirty()).toBe(true)
    offline = false
    await ui.controller.save()
    expect(ui.own.bambu_k_value).toBe('0.030')
    expect(ui.controller.isDirty()).toBe(false)
    expect(ui.mount.querySelector('[data-setup-error]')!.classList.contains('hidden')).toBe(true)
  })

  it('preserves edits during refresh and ignores disposed responses', async () => {
    const ui = await setup()
    const pending = ui.controller.refresh(); ui.change('bambu_k_value', '0.035'); await pending
    expect(ui.input('bambu_k_value').value).toBe('0.035')
    const disposed = ui.controller.refresh(); ui.controller.dispose()
    const html = ui.mount.innerHTML; await disposed
    expect(ui.mount.innerHTML).toBe(html)
  })
  it('does not let an older pending read hide a newer inherited setting', async () => {
    const ui = await setup()
    const fetchData = globalThis.fetch
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let held = false
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await fetchData(input, init)
      if (!held && String(input).includes('/filaments/3/printer-params?printer_id=1')) {
        held = true
        await gate
      }
      return response
    })
    const older = ui.controller.refresh()
    await vi.waitFor(() => expect(held).toBe(true))
    ui.parent.bambu_k_value = '0.045'
    const newer = ui.controller.refresh()
    try {
      await vi.waitFor(() => expect(ui.input('bambu_k_value').value).toBe('0.045'))
    } finally {
      release()
      await Promise.all([older, newer])
    }
    expect(ui.input('bambu_k_value').value).toBe('0.045')
  })
  it('does not expose mutation controls or management links to viewers', async () => {
    const ui = await setup({ readonly: true })
    expect(ui.mount.querySelector('a[href="/admin/system"]')).toBeNull()
    expect(ui.mount.querySelector('[data-setup-value], [data-setup-action="reset"]')).toBeNull()
    await expect(ui.controller.save()).rejects.toThrow()
  })
  it('explains inactive plugins and hides the card without printers', async () => {
    const ui = await setup({ inactivePlugin: true })
    expect(ui.mount.textContent).toContain('Enable the plugin')
    expect(initPerModelProfilePicker).not.toHaveBeenCalled()
    const empty = await setup({ noPrinters: true })
    expect(empty.mount.classList.contains('hidden')).toBe(true)
  })
  it('blocks page Save after a printer disappears', async () => {
    const ui = await setup()
    ui.change('bambu_k_value', '0.030'); ui.removePrinters(); await ui.controller.refresh()
    await expect(ui.controller.save()).rejects.toThrow()
    expect(ui.controller.isDirty()).toBe(true)
    expect(ui.calls.filter(c => c.method !== 'GET')).toEqual([])
  })
  it('preserves legacy nulls on sibling edits and clears filament records on reset', async () => {
    const ui = await setup({ entityType: 'filament' })
    ui.own.legacy = null; await ui.controller.refresh()
    ui.change('bambu_k_value', '0.030'); await ui.controller.save()
    expect(ui.own.legacy).toBeNull()
    ui.action('bambu_nozzle_temp_min', 'reset').click()
    expect(ui.input('bambu_nozzle_temp_min').value).toBe('')
    await ui.controller.save()
    expect(ui.own.bambu_nozzle_temp_min).toBeUndefined()
  })
})
