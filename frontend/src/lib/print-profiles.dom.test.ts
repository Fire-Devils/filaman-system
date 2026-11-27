// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'

vi.mock('./api', () => ({
  api: {
    get: vi.fn(async (path: string) => (path.startsWith('/printers') ? { items: [{ id: 3, name: 'MK4', printer_manufacturer: 'Prusa', printer_model: 'MK4' }, { id: 4, name: 'Unbekannt' }] } : [])),
  },
}))
vi.mock('./auth', async importOriginal => ({
  ...await importOriginal<typeof import('./auth')>(),
  getMe: vi.fn(async () => ({ is_superadmin: true, permissions: [] })),
}))
vi.mock('./filamentdb-contrib', () => ({
  mountContributeControl: vi.fn(async () => undefined),
  loadContribContext: vi.fn(async () => ({ canContribute: false, pluginActive: true, tokenSaved: false, needsToken: true })),
  contribErrorMessage: vi.fn(() => 'error'),
}))

import { initPrintProfiles } from './print-profiles'

describe('initPrintProfiles', () => {
  it('opens the dialog when "Add print profile" is clicked', async () => {
    // Same markup as PrintProfiles.astro + FormDialog.astro (heading without data-pp-title).
    document.body.innerHTML = `
      <section id="print-profiles"><button type="button" class="hidden" data-pp-add>Add</button>
        <div data-fdb-filament-contrib></div><div data-pp-list></div></section>
      <dialog id="print-profile-dialog"><header><h2 id="print-profile-dialog-title">Add</h2></header>
        <form><div data-pp-body></div><button type="button" data-pp-cancel>Cancel</button></form></dialog>`
    const mount = document.getElementById('print-profiles') as HTMLElement
    const dialog = document.getElementById('print-profile-dialog') as HTMLDialogElement
    const showModal = vi.fn(() => dialog.setAttribute('open', ''))
    dialog.showModal = showModal

    const handle = await initPrintProfiles({ mount, dialog, filamentId: 7 })
    await handle.reload()
    const add = mount.querySelector('[data-pp-add]') as HTMLButtonElement
    expect(add.classList.contains('hidden')).toBe(false)

    add.click()
    expect(showModal).toHaveBeenCalledOnce()
    expect(dialog.querySelector('#pp-printer')).not.toBeNull()

    // Drucker mit Modell füllt das Modell vor, Drucker ohne Modell zeigt den Hinweis mit Link.
    const select = dialog.querySelector('#pp-printer') as HTMLSelectElement
    const manufacturer = dialog.querySelector('#pp-manufacturer') as HTMLInputElement
    const warning = dialog.querySelector('#pp-printer-warning') as HTMLElement
    const defaultBox = dialog.querySelector('#pp-default') as HTMLInputElement
    expect(defaultBox.disabled).toBe(true)
    select.value = '3'
    select.dispatchEvent(new Event('change'))
    expect(manufacturer.value).toBe('Prusa')
    expect((dialog.querySelector('#pp-model') as HTMLInputElement).value).toBe('MK4')
    expect(warning.classList.contains('hidden')).toBe(true)
    expect(defaultBox.disabled).toBe(false)
    select.value = '4'
    select.dispatchEvent(new Event('change'))
    expect(warning.classList.contains('hidden')).toBe(false)
    expect(warning.innerHTML).toContain('/printers?edit=4')
  })
})
