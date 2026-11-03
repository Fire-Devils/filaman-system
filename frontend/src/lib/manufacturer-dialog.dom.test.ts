// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { CatalogEntry } from './manufacturer-catalog'

import { bindManufacturerCreateOption, createManufacturerDialog } from './manufacturer-dialog'

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('shared manufacturer dialog', () => {
  it('opens from the manufacturer dropdown without changing its current value', () => {
    document.body.innerHTML = '<select><option value="1" selected>Existing Brand</option></select>'
    const select = document.querySelector('select')!
    const open = vi.fn()
    bindManufacturerCreateOption(select, open)

    select.value = '__add_manufacturer__'
    select.dispatchEvent(new Event('change'))

    expect(open).toHaveBeenCalledOnce()
    expect(select.value).toBe('1')
    expect(select.options.item(select.options.length - 1)?.textContent).toBe('+ Add Manufacturer')
  })

  it('restores a manufacturer selected programmatically before opening', () => {
    document.body.innerHTML = `
      <select>
        <option value="1" selected>First Brand</option>
        <option value="2">Second Brand</option>
      </select>
    `
    const select = document.querySelector('select')!
    bindManufacturerCreateOption(select, vi.fn())

    select.value = '2'
    select.dispatchEvent(new Event('focus'))
    select.value = '__add_manufacturer__'
    select.dispatchEvent(new Event('change'))

    expect(select.value).toBe('2')
  })

  it('keeps labels associated with the shared form fields', () => {
    const dialog = createManufacturerDialog({
      filamentDbActive: false,
      onSaved: vi.fn(),
    })

    dialog.open()
    expect(document.querySelector<HTMLDialogElement>('.fm-modal-overlay')?.tagName).toBe('DIALOG')
    expect(document.querySelector<HTMLDialogElement>('.fm-modal-overlay')?.open).toBe(true)

    const name = document.querySelector<HTMLInputElement>('[data-manufacturer-name]')!
    expect(name.id).not.toBe('')
    expect(document.querySelector(`label[for="${name.id}"]`)).not.toBeNull()
    document.querySelector<HTMLDialogElement>('.fm-modal-overlay')!.dispatchEvent(new Event('cancel', { cancelable: true }))
    expect(document.querySelector<HTMLDialogElement>('.fm-modal-overlay')!.open).toBe(false)
  })

  it('creates a manufacturer and returns it to the host page', async () => {
    const created = {
      id: 42,
      name: 'New Brand',
      url: 'https://new.example',
      empty_spool_weight_g: 250,
      spool_material: 'Cardboard',
      spool_outer_diameter_mm: 200,
      spool_width_mm: 65,
    }
    const fetchStub = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(created), {
        headers: { 'Content-Type': 'application/json' },
        status: 200,
      }),
    )
    vi.stubGlobal('fetch', fetchStub)
    const onSaved = vi.fn()
    const dialog = createManufacturerDialog({
      filamentDbActive: false,
      onSaved,
    })

    dialog.open()
    document.querySelector<HTMLInputElement>('[data-manufacturer-name]')!.value = created.name
    document.querySelector<HTMLInputElement>('[data-manufacturer-url]')!.value = created.url
    document.querySelector<HTMLSelectElement>('[data-manufacturer-material]')!.value = created.spool_material
    document
      .querySelector<HTMLFormElement>('[data-manufacturer-form]')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))

    await vi.waitFor(() => expect(onSaved).toHaveBeenCalledWith(created, true))
    expect(document.querySelector<HTMLDialogElement>('.fm-modal-overlay')?.open).toBe(false)
    expect(fetchStub).toHaveBeenCalledWith(
      '/api/v1/manufacturers',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          name: 'New Brand',
          url: 'https://new.example',
          empty_spool_weight_g: 250,
          spool_material: 'Cardboard',
          spool_outer_diameter_mm: 200,
          spool_width_mm: 65,
        }),
      }),
    )
  })

  it('preserves the existing edit workflow', async () => {
    const updated = {
      id: 7,
      name: 'Updated Brand',
      url: null,
      empty_spool_weight_g: null,
      spool_material: null,
      spool_outer_diameter_mm: null,
      spool_width_mm: null,
    }
    const fetchStub = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(updated), {
        headers: { 'Content-Type': 'application/json' },
        status: 200,
      }),
    )
    vi.stubGlobal('fetch', fetchStub)
    const onSaved = vi.fn()
    const dialog = createManufacturerDialog({
      filamentDbActive: false,
      onSaved,
    })

    dialog.open({ ...updated, name: 'Old Brand' })
    expect(document.querySelector<HTMLInputElement>('[data-manufacturer-name]')!.value).toBe('Old Brand')
    document.querySelector<HTMLInputElement>('[data-manufacturer-name]')!.value = updated.name
    document
      .querySelector<HTMLFormElement>('[data-manufacturer-form]')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))

    await vi.waitFor(() => expect(onSaved).toHaveBeenCalledWith(updated, true))
    expect(fetchStub).toHaveBeenCalledWith('/api/v1/manufacturers/7', expect.objectContaining({ method: 'PATCH' }))
  })

  it.each(['resolve', 'reject'])('keeps a later save locked when an earlier refresh finishes (%s)', async outcome => {
    let finishRefresh!: () => void
    let failRefresh!: (error: Error) => void
    const refresh = new Promise<void>((resolve, reject) => { finishRefresh = resolve; failRefresh = reject })
    let finishSecondSave!: (response: Response) => void
    const fetchStub = vi.fn()
      .mockResolvedValueOnce(Response.json({ id: 7, name: 'First change' }))
      .mockImplementationOnce(() => new Promise<Response>(resolve => { finishSecondSave = resolve }))
    vi.stubGlobal('fetch', fetchStub)
    const onSaved = vi.fn().mockReturnValueOnce(refresh)
    const dialog = createManufacturerDialog({ onSaved })
    dialog.open({ id: 7, name: 'Original' })
    const form = document.querySelector<HTMLFormElement>('[data-manufacturer-form]')!
    const name = document.querySelector<HTMLInputElement>('[data-manufacturer-name]')!
    const save = document.querySelector<HTMLButtonElement>('[data-manufacturer-submit]')!
    const submit = () => form.dispatchEvent(new Event('submit', { cancelable: true }))
    name.value = 'First change'
    name.dispatchEvent(new Event('input', { bubbles: true }))
    submit()
    await vi.waitFor(() => expect(onSaved).toHaveBeenCalledOnce())

    document.querySelector<HTMLButtonElement>('[data-manufacturer-edit]')!.click()
    name.value = 'Second change'
    name.dispatchEvent(new Event('input', { bubbles: true }))
    submit()
    expect(fetchStub).toHaveBeenCalledTimes(2)
    expect(form.inert).toBe(true)
    expect(save.disabled).toBe(true)

    if (outcome === 'resolve') finishRefresh()
    else failRefresh(new Error('Earlier refresh failed'))
    await refresh.catch(() => {})
    expect(form.inert).toBe(true)
    expect(save.disabled).toBe(true)
    expect(document.querySelector('[data-manufacturer-error]')!.classList.contains('hidden')).toBe(true)
    submit()
    expect(fetchStub).toHaveBeenCalledTimes(2)

    finishSecondSave(Response.json({ id: 7, name: 'Second change' }))
    await vi.waitFor(() => expect(form.inert).toBe(false))
    expect(name.value).toBe('Second change')
    expect(name.readOnly).toBe(true)
    expect(onSaved).toHaveBeenCalledTimes(2)
  })
})


describe('manufacturer view/edit layout', () => {
  it('uses the same controls for view/edit and restores values on cancel', () => {
    const dialog = createManufacturerDialog({ filamentDbActive: false, onSaved: vi.fn() })
    dialog.open({ id: 3, name: 'Maker', custom_fields: { manufacturer_profile: { description: 'Original' } } }, { mode: 'view' })
    const name = document.querySelector<HTMLInputElement>('[data-manufacturer-name]')!
    expect(name.readOnly).toBe(true)
    document.querySelector<HTMLButtonElement>('[data-manufacturer-edit]')!.click()
    expect(name.readOnly).toBe(false)
    const save = document.querySelector<HTMLButtonElement>('[data-manufacturer-submit]')!
    expect(save.disabled).toBe(true)
    name.value = 'Changed'
    name.dispatchEvent(new Event('input', { bubbles: true }))
    expect(save.disabled).toBe(false)
    document.querySelector<HTMLButtonElement>('[data-manufacturer-cancel]')!.click()
    expect(name.value).toBe('Maker')
    expect(name.readOnly).toBe(true)
    expect(document.querySelector<HTMLDialogElement>('dialog')!.open).toBe(true)
  })

  it('supports another source and stages selected fields without clearing local blanks', async () => {
    const source = { key: 'other', label: 'Other DB', endpoint: '/other/manufacturers',
      normalize: (raw: Record<string, unknown>) => raw as CatalogEntry,
      load: vi.fn().mockResolvedValue({ id: 'abc', name: 'Maker', website: '', contact_email: 'new@example.test', description: '', details: { active: true } }) }
    const fetchStub = vi.fn().mockImplementation(async (_url, options) => new Response(JSON.stringify({ id: 3, ...JSON.parse(options.body) })))
    vi.stubGlobal('fetch', fetchStub)
    const dialog = createManufacturerDialog({ sources: [source], onSaved: vi.fn() })
    dialog.open({ id: 3, name: 'Maker', url: 'https://local.test', custom_fields: { untouched: 42, catalog_sources: { other: { id: 'abc' } } } }, { mode: 'view' })
    await vi.waitFor(() => expect(document.querySelector('[data-catalog-compare]')).not.toBeNull())
    document.querySelector<HTMLButtonElement>('[data-catalog-compare]')!.click()
    const email = document.querySelector<HTMLInputElement>('[data-catalog-field="contact_email"]')!
    expect(email).not.toBeNull()
    email.checked = true
    document.querySelector<HTMLButtonElement>('[data-catalog-apply]')!.click()
    expect(document.querySelector<HTMLInputElement>('[data-manufacturer-url]')!.value).toBe('https://local.test')
    document.querySelector<HTMLFormElement>('[data-manufacturer-form]')!.dispatchEvent(new Event('submit', { cancelable: true }))
    await vi.waitFor(() => expect(fetchStub).toHaveBeenCalled())
    const saved = JSON.parse(fetchStub.mock.calls[0][1].body)
    expect(saved.custom_fields).toMatchObject({ untouched: 42, manufacturer_profile: { contact_email: 'new@example.test' }, catalog_sources: { other: { id: 'abc' } } })
    expect(saved.url).toBe('https://local.test')
  })
})

it('keeps provider metadata and shows the selected catalog entry after apply/save', async () => {
  const entry = { id: 'abc', name: 'Catalog maker', website: '', contact_email: '', description: '', details: {} }
  const source = { key: 'other', label: 'Other DB', endpoint: '/other', normalize: (raw: Record<string, unknown>) => raw as CatalogEntry, load: async () => entry }
  let resolveSave!: (response: Response) => void
  const fetchStub = vi.fn().mockImplementation(() => new Promise<Response>(resolve => { resolveSave = resolve }))
  vi.stubGlobal('fetch', fetchStub)
  const dialog = createManufacturerDialog({ sources: [source], onSaved: vi.fn() })
  dialog.open({ id: 3, name: 'Local maker', custom_fields: { catalog_sources: { other: { id: 'abc', sync: { enabled: true } } } } }, { mode: 'view' })
  await vi.waitFor(() => expect(document.querySelector('[data-catalog-compare]')).not.toBeNull())
  document.querySelector<HTMLButtonElement>('[data-catalog-compare]')!.click()
  document.querySelector<HTMLButtonElement>('[data-catalog-apply]')!.click()
  expect(document.querySelector('.manufacturer-source-summary strong')!.textContent).toBe(entry.name)
  document.querySelector<HTMLFormElement>('form')!.dispatchEvent(new Event('submit', { cancelable: true }))
  await vi.waitFor(() => expect(fetchStub).toHaveBeenCalled())
  expect(document.querySelector<HTMLFormElement>('form')!.inert).toBe(true)
  const payload = JSON.parse(fetchStub.mock.calls[0][1].body)
  expect(payload.custom_fields.catalog_sources.other.sync).toEqual({ enabled: true })
  resolveSave(new Response(JSON.stringify({ id: 3, ...payload })))
  await vi.waitFor(() => expect(document.querySelector<HTMLFormElement>('form')!.inert).toBe(false))
  expect(document.querySelector('.manufacturer-source-summary strong')!.textContent).toBe(entry.name)
})

it('allows retrying a failed logo without changing saved field values', async () => {
  const entry = { id: 'abc', name: 'Maker', website: '', contact_email: '', description: '', logo_url: '/catalog.png', details: {} }
  const source = { key: 'other', label: 'Other DB', endpoint: '/other', normalize: (raw: Record<string, unknown>) => raw as CatalogEntry, load: async () => entry, saveLogo: vi.fn().mockRejectedValue(new Error('offline')) }
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async (_url, options) => new Response(JSON.stringify({ id: 3, ...JSON.parse(options.body) }))))
  const dialog = createManufacturerDialog({ sources: [source], onSaved: vi.fn() })
  dialog.open({ id: 3, name: 'Maker', custom_fields: { catalog_sources: { other: { id: 'abc' } } } }, { mode: 'view' })
  await vi.waitFor(() => expect(document.querySelector('[data-catalog-compare]')).not.toBeNull())
  const apply = () => {
    document.querySelector<HTMLButtonElement>('[data-catalog-compare]')!.click()
    document.querySelector<HTMLButtonElement>('[data-catalog-apply]')!.click()
  }
  apply()
  document.querySelector<HTMLFormElement>('form')!.dispatchEvent(new Event('submit', { cancelable: true }))
  await vi.waitFor(() => expect(source.saveLogo).toHaveBeenCalledOnce())
  await vi.waitFor(() => expect(document.querySelector<HTMLFormElement>('form')!.inert).toBe(false))
  apply()
  expect(document.querySelector<HTMLButtonElement>('[data-manufacturer-submit]')!.disabled).toBe(false)
})

it('preserves an existing logo unless the catalog logo is explicitly selected', async () => {
  const entry = { id: 'a', name: 'Maker', website: '', contact_email: '', description: '', logo_url: '/catalog.png', details: {} }
  const source = { key: 'other', label: 'Other DB', endpoint: '/other', normalize: () => entry, load: async () => entry, saveLogo: vi.fn() }
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async (_url, options) => new Response(JSON.stringify({ id: 3, ...JSON.parse(options.body), logo_url: '/saved-logo.png' }))))
  const dialog = createManufacturerDialog({ sources: [source], onSaved: vi.fn() })
  dialog.open({ id: 3, name: 'Maker', logo_url: '/saved-logo.png', custom_fields: { catalog_sources: { other: { id: 'a' } } } }, { mode: 'view' })
  await vi.waitFor(() => expect(document.querySelector('[data-catalog-compare]')).not.toBeNull())
  document.querySelector<HTMLButtonElement>('[data-catalog-compare]')!.click()
  const useLogo = document.querySelector<HTMLInputElement>('[data-catalog-logo]')!
  expect(useLogo).not.toBeNull()
  expect(useLogo.checked).toBe(false)
  document.querySelector<HTMLButtonElement>('[data-catalog-apply]')!.click()
  document.querySelector<HTMLFormElement>('form')!.dispatchEvent(new Event('submit', { cancelable: true }))
  await vi.waitFor(() => expect(document.querySelector<HTMLFormElement>('form')!.inert).toBe(false))
  expect(source.saveLogo).not.toHaveBeenCalled()
})

it('places clickable inventory metrics in the header with explicit manufacturer and status scopes', () => {
  const dialog = createManufacturerDialog({ filamentDbActive: false, onSaved: vi.fn() })
  dialog.open({ id: 7, name: 'Maker', filament_count: 12, spool_count: 30, archived_spool_count: 5, materials: ['PLA'], total_price_available: 25, total_price_all: 40 }, { mode: 'view' })
  const header = document.querySelector('.manufacturer-header')!
  expect(header.querySelector('.manufacturer-identity .manufacturer-field')!.previousElementSibling?.id).toBe('manufacturer-dialog-title')
  const metrics = header.querySelectorAll<HTMLAnchorElement>('.manufacturer-metric')
  expect(metrics).toHaveLength(3)
  expect(metrics[0].textContent).toContain('12')
  expect(metrics[0].getAttribute('href')).toBe('/filaments?manufacturer_id=7&clear_filters=1')
  expect(metrics[1].getAttribute('href')).toBe('/spools?manufacturer_id=7&clear_filters=1&status_scope=active')
  expect(metrics[2].getAttribute('href')).toBe('/spools?manufacturer_id=7&clear_filters=1&status_scope=archived')
  expect(metrics[2].querySelector('svg')).not.toBeNull()
  expect(header.querySelector('[data-manufacturer-stats]')).not.toBeNull()
})

it('keeps comparison selections when another catalog detail response finishes', async () => {
  const snapshot = { id: 'a', name: 'Maker', website: '', contact_email: 'snapshot@example.test', description: '', details: {} }
  let resolveFirst!: (entry: CatalogEntry) => void
  let resolveSecond!: (entry: CatalogEntry) => void
  const first = { key: 'first', label: 'First', endpoint: '/first', normalize: () => snapshot, load: () => new Promise<CatalogEntry>(resolve => { resolveFirst = resolve }) }
  const second = { key: 'second', label: 'Second', endpoint: '/second', normalize: () => snapshot, load: () => new Promise<CatalogEntry>(resolve => { resolveSecond = resolve }) }
  const dialog = createManufacturerDialog({ sources: [first, second], onSaved: vi.fn() })
  dialog.open({ id: 3, name: 'Maker', custom_fields: { catalog_sources: { first: { id: 'a', snapshot }, second: { id: 'a', snapshot } } } }, { mode: 'view' })
  expect(document.querySelector('.manufacturer-source h3 [data-catalog-compare]')).not.toBeNull()
  expect(document.querySelector('.manufacturer-source h3 .manufacturer-source-summary strong')!.textContent).toBe('Maker')
  document.querySelector<HTMLButtonElement>('[data-catalog-compare]')!.click()
  const email = document.querySelector<HTMLInputElement>('[data-catalog-field="contact_email"]')!
  email.checked = true
  resolveSecond({ ...snapshot, name: 'Fresh second' })
  await vi.waitFor(() => expect(document.querySelectorAll('.manufacturer-source-summary strong')[1].textContent).toBe('Fresh second'))
  resolveFirst({ ...snapshot, name: 'Fresh first' })
  await vi.waitFor(() => expect(document.querySelector('.manufacturer-source-summary strong')!.textContent).toBe('Fresh first'))
  expect(document.querySelector('[data-catalog-field="contact_email"]')).toBe(email)
  expect(email.checked).toBe(true)
  expect(document.querySelector<HTMLElement>('[data-catalog-comparison]')!.hidden).toBe(false)
  document.querySelector<HTMLButtonElement>('[data-catalog-apply]')!.click()
  expect(document.querySelector<HTMLInputElement>('[data-manufacturer-email]')!.value).toBe('snapshot@example.test')
})

it('renders provider status tones while preserving plain summaries and escaping labels', () => {
  const entry = { id: 'a', name: 'Maker', website: '', contact_email: '', description: '', details: {} }
  const source = { key: 'other', label: 'Other DB', endpoint: '/other', normalize: () => entry, load: async () => entry,
    summary: () => [{ label: 'Active <catalog>', tone: 'success' as const }, { label: 'Inactive', tone: 'warning' as const }, 'Not verified'] }
  const dialog = createManufacturerDialog({ sources: [source], onSaved: vi.fn() })
  dialog.open({ id: 3, name: 'Maker', custom_fields: { catalog_sources: { other: { id: 'a', snapshot: entry } } } }, { mode: 'view' })
  const badges = document.querySelector('.manufacturer-catalog-summary')!
  expect(badges.querySelector('.is-success')!.textContent).toBe('Active <catalog>')
  expect(badges.querySelector('.is-warning')!.textContent).toBe('Inactive')
  expect(badges.querySelector('catalog')).toBeNull()
  expect(badges.lastElementChild!.textContent).toBe('Not verified')
})

describe('manufacturer catalog display freshness', () => {
  const snapshot: CatalogEntry = { id: 1, name: 'Old catalog', website: '', contact_email: 'old@example.test', description: '', details: { is_active: false } }
  const fresh: CatalogEntry = { ...snapshot, name: 'Fresh catalog', contact_email: 'fresh@example.test', details: { is_active: true } }

  it.each(['save', 'cancel'])('keeps fetched values after an unrelated %s without accepting them', async action => {
    let savedFields: unknown
    vi.stubGlobal('fetch', async (_url: string, options: RequestInit) => {
      const payload = JSON.parse(options.body as string)
      savedFields = payload.custom_fields
      return new Response(JSON.stringify({ id: 3, ...payload }))
    })
    const source = { key: 'other', label: 'Other DB', endpoint: '/other', normalize: () => fresh, load: async () => fresh,
      summary: (entry: CatalogEntry) => [entry.details.is_active ? 'Active' : 'Inactive'] }
    const dialog = createManufacturerDialog({ sources: [source], onSaved: vi.fn() })
    dialog.open({ id: 3, name: 'Local', custom_fields: { manufacturer_profile: { contact_email: 'fresh@example.test', description: '' }, catalog_sources: { other: { id: 1, snapshot } } } }, { mode: 'view' })
    await vi.waitFor(() => expect(document.querySelector('.manufacturer-source-summary strong')!.textContent).toBe('Fresh catalog'))
    document.querySelector<HTMLButtonElement>('[data-manufacturer-edit]')!.click()
    const width = document.querySelector<HTMLInputElement>('[data-manufacturer-width]')!
    width.value = '71'
    width.dispatchEvent(new Event('input', { bubbles: true }))
    if (action === 'save') {
      document.querySelector<HTMLFormElement>('form')!.dispatchEvent(new Event('submit', { cancelable: true }))
      await vi.waitFor(() => expect(document.querySelector<HTMLInputElement>('[data-manufacturer-name]')!.readOnly).toBe(true))
      expect(savedFields).toEqual({ manufacturer_profile: { contact_email: 'fresh@example.test', description: '' }, catalog_sources: { other: { id: 1, snapshot } } })
    } else document.querySelector<HTMLButtonElement>('[data-manufacturer-cancel]')!.click()
    expect(document.querySelector('.manufacturer-source-summary strong')!.textContent).toBe('Fresh catalog')
    expect(document.querySelector('.manufacturer-catalog-summary')!.textContent).toBe('Active')
    document.querySelector<HTMLButtonElement>('[data-catalog-compare]')!.click()
    expect(document.querySelector('[data-catalog-field="contact_email"]')).toBeNull()
    expect(document.querySelector<HTMLInputElement>('[data-manufacturer-email]')!.value).toBe('fresh@example.test')
  })

  it.each([
    { loaded: true, stored: true, selectedId: 1 },
    { loaded: true, stored: true, selectedId: 2 },
    { loaded: true, stored: false, selectedId: 1 },
    { loaded: true, stored: false, selectedId: 2 },
    { loaded: false, stored: true, selectedId: 1 },
    { loaded: false, stored: true, selectedId: 2 },
    { loaded: false, stored: false, selectedId: 1 },
    { loaded: false, stored: false, selectedId: 2 },
  ])('discards lookup drafts on cancel ($loaded loaded, $stored snapshot, selected ID $selectedId)', async ({ loaded, stored, selectedId }) => {
    const draft: CatalogEntry = { ...snapshot, id: selectedId, name: 'Draft catalog', contact_email: 'draft@example.test' }
    let savedFields: unknown
    vi.stubGlobal('fetch', async (url: string, options: RequestInit) => {
      if (url.startsWith('/api/v1/other?')) return new Response(JSON.stringify({ items: [draft] }))
      const payload = JSON.parse(options.body as string)
      savedFields = payload.custom_fields
      return new Response(JSON.stringify({ id: 3, ...payload }))
    })
    const link = stored ? { id: 1, snapshot } : { id: 1 }
    const source = { key: 'other', label: 'Other DB', endpoint: '/other', normalize: (raw: Record<string, unknown>) => raw as CatalogEntry,
      load: async () => { if (!loaded) throw new Error('offline'); return fresh } }
    const dialog = createManufacturerDialog({ sources: [source], onSaved: vi.fn() })
    dialog.open({ id: 3, name: 'Local', custom_fields: { catalog_sources: { other: link } } }, { mode: 'view' })
    await vi.waitFor(() => {
      if (loaded) expect(document.querySelector('.manufacturer-source-summary strong')!.textContent).toBe('Fresh catalog')
      else expect(document.querySelector('.manufacturer-source-error')!.textContent).not.toBe('')
    })
    const lookup = document.querySelector<HTMLDetailsElement>('.manufacturer-lookup-details')!
    lookup.open = true
    lookup.dispatchEvent(new Event('toggle'))
    await vi.waitFor(() => expect(document.querySelector('.fdb-lookup-item')).not.toBeNull())
    document.querySelector<HTMLButtonElement>('.fdb-lookup-item')!.click()
    document.querySelector<HTMLInputElement>('[data-catalog-field="contact_email"]')!.checked = true
    document.querySelector<HTMLButtonElement>('[data-catalog-apply]')!.click()
    expect(document.querySelector('.manufacturer-source-summary strong')!.textContent).toBe('Draft catalog')
    expect(document.querySelector<HTMLInputElement>('[data-manufacturer-email]')!.value).toBe('draft@example.test')
    document.querySelector<HTMLButtonElement>('[data-manufacturer-cancel]')!.click()
    expect(document.querySelector('.manufacturer-source-summary strong')?.textContent).toBe(loaded ? 'Fresh catalog' : stored ? 'Old catalog' : undefined)
    expect(document.querySelector<HTMLInputElement>('[data-manufacturer-email]')!.value).toBe('')
    expect(document.querySelector<HTMLButtonElement>('[data-catalog-compare]')!.hidden).toBe(!loaded && !stored)
    document.querySelector<HTMLButtonElement>('[data-manufacturer-edit]')!.click()
    document.querySelector<HTMLInputElement>('[data-manufacturer-width]')!.value = '71'
    document.querySelector<HTMLFormElement>('form')!.dispatchEvent(new Event('submit', { cancelable: true }))
    await vi.waitFor(() => expect(document.querySelector<HTMLInputElement>('[data-manufacturer-name]')!.readOnly).toBe(true))
    expect(savedFields).toEqual({ manufacturer_profile: { contact_email: '', description: '' }, catalog_sources: { other: link } })
  })

  it.each([1, 2])('keeps a late saved-link response behind a staged lookup for ID %s until cancel', async selectedId => {
    let resolveLoad!: (entry: CatalogEntry) => void
    const draft = { ...snapshot, id: selectedId, name: 'Draft catalog' }
    const source = { key: 'other', label: 'Other DB', endpoint: '/other', normalize: () => draft,
      load: () => new Promise<CatalogEntry>(resolve => { resolveLoad = resolve }) }
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ items: [draft] })))
    const dialog = createManufacturerDialog({ sources: [source], onSaved: vi.fn() })
    dialog.open({ id: 3, name: 'Local', custom_fields: { catalog_sources: { other: { id: 1, snapshot } } } }, { mode: 'view' })
    const lookup = document.querySelector<HTMLDetailsElement>('.manufacturer-lookup-details')!
    lookup.open = true
    lookup.dispatchEvent(new Event('toggle'))
    await vi.waitFor(() => expect(document.querySelector('.fdb-lookup-item')).not.toBeNull())
    document.querySelector<HTMLButtonElement>('.fdb-lookup-item')!.click()
    document.querySelector<HTMLButtonElement>('[data-catalog-apply]')!.click()
    resolveLoad(fresh)
    await Promise.resolve()
    expect(document.querySelector('.manufacturer-source-summary strong')!.textContent).toBe('Draft catalog')
    document.querySelector<HTMLButtonElement>('[data-manufacturer-cancel]')!.click()
    expect(document.querySelector('.manufacturer-source-summary strong')!.textContent).toBe('Fresh catalog')
  })
})
