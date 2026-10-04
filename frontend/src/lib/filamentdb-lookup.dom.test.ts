// @vitest-environment happy-dom

import { describe, expect, it, vi } from 'vitest'

import * as filamentLookup from './filamentdb-lookup'
import type { LookupInstance } from './filamentdb-lookup'

describe('manufacturer filament lookup', () => {
  it('shows and rebuilds the search field as the manufacturer changes', () => {
    document.body.innerHTML = `
      <select>
        <option value="">Select manufacturer...</option>
        <option value="1">First Brand</option>
        <option value="2">Second Brand</option>
      </select>
      <input id="search-all" type="checkbox">
      <div style="display:none"></div>
    `
    const select = document.querySelector('select')!
    const searchAll = document.querySelector<HTMLInputElement>('#search-all')!
    const section = document.querySelector('div')!
    const destroy = vi.fn()
    const createLookup = vi.fn(() => ({ destroy, reset: vi.fn(), search: vi.fn() }) satisfies LookupInstance)
    filamentLookup.bindFilamentDbLookupToManufacturer(select, searchAll, section, createLookup)

    select.value = '1'
    select.dispatchEvent(new Event('change'))

    expect(section.style.display).toBe('')
    expect(searchAll.disabled).toBe(true)
    expect(createLookup).toHaveBeenLastCalledWith(true)

    select.value = '2'
    select.dispatchEvent(new Event('change'))

    expect(destroy).toHaveBeenCalledOnce()
    expect(createLookup).toHaveBeenCalledTimes(2)

    select.value = ''
    select.dispatchEvent(new Event('change'))

    expect(section.style.display).toBe('none')
    expect(searchAll.disabled).toBe(false)
    expect(destroy).toHaveBeenCalledTimes(2)
  })

  it('enables an unscoped search before a manufacturer is selected', () => {
    document.body.innerHTML = `
      <select><option value="">Select manufacturer...</option><option value="1">First Brand</option></select>
      <input id="search-all" type="checkbox">
      <div style="display:none"></div>
    `
    const select = document.querySelector('select')!
    const searchAll = document.querySelector<HTMLInputElement>('#search-all')!
    const section = document.querySelector('div')!
    const destroy = vi.fn()
    const createLookup = vi.fn(() => ({ destroy, reset: vi.fn(), search: vi.fn() }) satisfies LookupInstance)
    filamentLookup.bindFilamentDbLookupToManufacturer(select, searchAll, section, createLookup)

    searchAll.checked = true
    searchAll.dispatchEvent(new Event('change'))

    expect(section.style.display).toBe('')
    expect(createLookup).toHaveBeenLastCalledWith(false)

    select.value = '1'
    select.dispatchEvent(new Event('change'))

    expect(searchAll.checked).toBe(false)
    expect(searchAll.disabled).toBe(true)
    expect(createLookup).toHaveBeenLastCalledWith(true)
  })

})
