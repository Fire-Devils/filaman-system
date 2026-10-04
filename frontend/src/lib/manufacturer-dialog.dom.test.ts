// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'

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

    await vi.waitFor(() => expect(onSaved).toHaveBeenCalledWith(created))
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

    await vi.waitFor(() => expect(onSaved).toHaveBeenCalledWith(updated))
    expect(fetchStub).toHaveBeenCalledWith('/api/v1/manufacturers/7', expect.objectContaining({ method: 'PATCH' }))
  })
})
