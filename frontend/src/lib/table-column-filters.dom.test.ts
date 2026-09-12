// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'

import { bindColorFilterButton, initHeaderColumnFilters } from './table-column-filters'
import { setLang } from './i18n'

afterEach(() => {
  document.body.innerHTML = ''
  localStorage.removeItem('filaman-color-range-open')
  localStorage.removeItem('filaman-spool-status-open')
  setLang('en')
  vi.restoreAllMocks()
})

describe('header filter accessibility', () => {
  it('localizes accessible names and closes the controlled panel with Escape', () => {
    setLang('de')
    document.body.innerHTML = '<table><thead><tr><th class="col-name">Name</th></tr></thead></table>'
    initHeaderColumnFilters(document.querySelector('table')!, [{
      key: 'name', label: 'Name', columnSelector: 'th.col-name', type: 'text', onApply: vi.fn(),
    }])

    const trigger = document.querySelector<HTMLButtonElement>('.fm-header-filter-trigger')!
    const panel = document.querySelector<HTMLElement>('.fm-header-filter-panel')!
    trigger.click()

    expect(trigger.getAttribute('aria-label')).toBe('Name filtern')
    expect(trigger.getAttribute('aria-controls')).toBe(panel.id)
    expect(panel.getAttribute('role')).toBe('dialog')
    expect(document.querySelector('.fm-header-filter-operator')?.getAttribute('aria-label'))
      .toBe('Filteroperator für Name')

    panel.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }))

    expect(panel.classList.contains('open')).toBe(false)
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(trigger)
  })

  it('nests a default-open status filter behind the Spools filter', () => {
    document.body.innerHTML = '<table><thead><tr><th class="col-spools">Spools</th></tr></thead></table>'
    const onSpools = vi.fn()
    const onStatus = vi.fn()
    const controller = initHeaderColumnFilters(document.querySelector('table')!, [
      {
        key: 'spools', label: 'Spools', columnSelector: 'th.col-spools', type: 'number', onApply: onSpools,
      },
      {
        key: 'spoolStatus', label: 'Spool Status', columnSelector: 'th.col-spools', type: 'multi',
        icon: 'gear', disclosureOf: 'spools', disclosureStorageKey: 'filaman-spool-status-open',
        searchable: false,
        options: [{ value: 'full', label: 'Full' }, { value: 'empty', label: 'Empty' }], onApply: onStatus,
      },
    ])

    expect(document.querySelectorAll('.fm-header-filter-trigger')).toHaveLength(1)
    const trigger = document.querySelector<HTMLButtonElement>('.fm-header-filter-trigger')!
    trigger.click()
    const rootPanel = document.querySelector<HTMLElement>('.fm-header-filter-panel:not(.fm-header-linked-filter-panel)')!
    const details = rootPanel.querySelector<HTMLDetailsElement>('.fm-header-filter-disclosure')!
    const summary = details.querySelector<HTMLElement>('summary')!
    const statusPanel = details.querySelector<HTMLElement>('.fm-header-linked-filter-panel')!

    expect(details.open).toBe(true)
    expect(summary.getAttribute('aria-label')).toBe('Filter Spool Status')
    expect(summary.title).toBe('Filter Spool Status')
    expect(summary.dataset.tooltip).toBe('Filter Spool Status')
    expect(summary.querySelector('svg')).not.toBeNull()
    expect(statusPanel.parentElement).toBe(details)
    expect(statusPanel.querySelector('.fm-header-filter-search')).toBeNull()
    expect(statusPanel.querySelector('.fm-btn-primary')).toBeNull()
    expect(rootPanel.querySelector<HTMLButtonElement>('.fm-header-filter-actions [data-filter-clear]')?.textContent)
      .toBe('Clear Spools')
    expect(statusPanel.querySelector<HTMLButtonElement>('[data-filter-clear]')?.textContent).toBe('Clear Spool Status')

    const count = rootPanel.querySelector<HTMLInputElement>('.fm-header-filter-typed-controls .fm-header-filter-value')!
    count.value = '2'
    count.dispatchEvent(new Event('input', { bubbles: true }))
    statusPanel.querySelector<HTMLInputElement>('[data-value="full"]')!.click()
    rootPanel.querySelector<HTMLButtonElement>('.fm-header-filter-actions .fm-btn-primary')!.click()

    expect(onSpools).toHaveBeenCalledWith({ type: 'number', operator: 'eq', value: '2', valueTo: '' })
    expect(onStatus).toHaveBeenCalledWith({ type: 'multi', values: ['full'] })
    expect(controller.getValue('spoolStatus')).toEqual({ type: 'multi', values: ['full'] })
    expect(trigger.classList.contains('active')).toBe(true)

    trigger.click()
    details.open = false
    details.dispatchEvent(new Event('toggle'))
    expect(localStorage.getItem('filaman-spool-status-open')).toBe('false')
  })

  it('offers native text suggestions without restricting free text', () => {
    document.body.innerHTML = '<table><thead><tr><th class="col-designation">Designation</th></tr></thead></table>'
    const onApply = vi.fn()
    const controller = initHeaderColumnFilters(document.querySelector('table')!, [{
      key: 'designation',
      label: 'Designation',
      columnSelector: 'th.col-designation',
      type: 'text',
      autocomplete: true,
      onApply,
    }])

    controller.setOptions('designation', [
      { value: 'PLA Basic', label: 'PLA Basic' },
      { value: 'PETG Matte', label: 'PETG Matte' },
    ])
    document.querySelector<HTMLButtonElement>('.fm-header-filter-trigger')!.click()

    const input = document.querySelector<HTMLInputElement>('.fm-header-filter-value')!
    const suggestions = document.getElementById(input.getAttribute('list')!) as HTMLDataListElement
    expect([...suggestions.options].map((option) => option.value)).toEqual(['PLA Basic', 'PETG Matte'])

    input.value = 'Custom designation'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    document.querySelector<HTMLButtonElement>('.fm-header-filter-actions .fm-btn-primary')!.click()
    expect(onApply).toHaveBeenCalledWith({ type: 'text', operator: 'contains', value: 'Custom designation' })
  })

  it('offers integer suggestions without removing numeric operators', () => {
    document.body.innerHTML = '<table><thead><tr><th class="col-spools">Spools</th></tr></thead></table>'
    const controller = initHeaderColumnFilters(document.querySelector('table')!, [{
      key: 'spools',
      label: 'Spools',
      columnSelector: 'th.col-spools',
      type: 'number',
      autocomplete: true,
      onApply: vi.fn(),
    }])

    controller.setOptions('spools', ['0', '1', '3'].map(value => ({ value, label: value })))
    document.querySelector<HTMLButtonElement>('.fm-header-filter-trigger')!.click()

    const inputs = [...document.querySelectorAll<HTMLInputElement>('.fm-header-filter-value')]
    const suggestions = document.getElementById(inputs[0].getAttribute('list')!) as HTMLDataListElement
    expect(inputs.map(input => [input.type, input.step, input.getAttribute('list')])).toEqual([
      ['number', '1', suggestions.id],
      ['number', '1', suggestions.id],
    ])
    expect([...suggestions.options].map(option => option.value)).toEqual(['0', '1', '3'])
    expect([...document.querySelectorAll<HTMLSelectElement>('.fm-header-filter-operator option')].map(option => option.value))
      .toContain('gt')
  })
})

describe('color range header filter', () => {
  function mountColorOptions(onApply = vi.fn()) {
    document.body.innerHTML = '<table><thead><tr><th class="col-colors">Colors</th></tr></thead></table>'
    initHeaderColumnFilters(document.querySelector('table')!, [{
      key: 'colors',
      label: 'Colors',
      columnSelector: 'th.col-colors',
      type: 'multi',
      multiDisplay: 'colors',
      options: [
        { value: 'Red', label: 'Red', colorHexes: ['#FF0000'] },
        { value: 'Green', label: 'Green', colorHexes: ['#00FF00'] },
        { value: 'Black', label: 'Black', colorHexes: ['#000000'] },
      ],
      onApply,
    }])
    document.querySelector<HTMLButtonElement>('.fm-header-filter-trigger')!.click()
    return { onApply }
  }

  it('emits standalone range changes live and exposes only Clear', () => {
    document.body.innerHTML = '<button id="color-filter">Filter colors</button>'
    const onChange = vi.fn()
    const trigger = document.querySelector<HTMLButtonElement>('#color-filter')!
    bindColorFilterButton(trigger, onChange)

    trigger.click()
    document.querySelector<HTMLButtonElement>('[data-color-preset="red"]')!.click()
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ mode: 'color', hueFrom: 320, hueTo: 15 }))
    expect(trigger.classList.contains('active')).toBe(true)
    expect(document.querySelector('.fm-header-filter-actions .fm-btn-primary')).toBeNull()

    document.querySelector<HTMLButtonElement>('.fm-header-filter-actions .fm-btn-outline')!.click()
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ mode: 'none' }))
    expect(trigger.classList.contains('active')).toBe(false)
  })

  it('lets the host clear a standalone color filter after selection', () => {
    document.body.innerHTML = '<button id="color-filter">Filter colors</button>'
    const trigger = document.querySelector<HTMLButtonElement>('#color-filter')!
    const onApply = vi.fn()
    const clearFilter = bindColorFilterButton(trigger, onApply)

    trigger.click()
    document.querySelector<HTMLButtonElement>('[data-color-neutral="black"]')!.click()
    clearFilter()

    expect(onApply).toHaveBeenLastCalledWith(expect.objectContaining({ mode: 'none' }))
    expect(trigger.classList.contains('active')).toBe(false)
  })

  it('opens one grid-first Colors popover with a remembered range disclosure', () => {
    mountColorOptions()

    expect(document.querySelectorAll('.fm-header-filter-trigger')).toHaveLength(1)
    expect(document.querySelector('.fm-header-filter-list')?.classList.contains('fm-color-grid')).toBe(true)
    const details = document.querySelector<HTMLDetailsElement>('.fm-header-color-disclosure')!
    expect(details.open).toBe(true)
    expect(details.querySelector('summary')?.getAttribute('aria-label')).toBe('Color filter')
    expect(details.querySelector('summary .fm-header-color-wheel-icon')).not.toBeNull()
    expect(details.querySelector('.fm-header-color-disclosure-panel')?.parentElement).toBe(details)
    expect(details.closest('.fm-header-filter-panel')?.classList.contains('fm-header-filter-panel-color')).toBe(true)
    expect(details.querySelector('.fm-header-color-controls')?.classList.contains('is-inactive')).toBe(true)

    details.open = false
    details.dispatchEvent(new Event('toggle'))
    expect(localStorage.getItem('filaman-color-range-open')).toBe('false')
  })

  it('shifts a tall color sidecar up before constraining its height', () => {
    mountColorOptions()
    const trigger = document.querySelector<HTMLButtonElement>('.fm-header-filter-trigger')!
    const panel = document.querySelector<HTMLElement>('.fm-header-filter-panel')!
    const sidecar = document.querySelector<HTMLElement>('.fm-header-color-disclosure-panel')!
    trigger.click()
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1024)
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(768)
    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({
      bottom: 250, height: 30, left: 870, right: 900, top: 220, width: 30,
      x: 870, y: 220, toJSON: () => ({}),
    })
    vi.spyOn(panel, 'offsetWidth', 'get').mockReturnValue(360)
    vi.spyOn(panel, 'offsetHeight', 'get').mockReturnValue(170)
    vi.spyOn(sidecar, 'offsetWidth', 'get').mockReturnValue(360)
    vi.spyOn(sidecar, 'offsetHeight', 'get').mockReturnValue(600)
    vi.spyOn(sidecar, 'scrollHeight', 'get').mockReturnValue(600)

    trigger.click()

    expect(panel.style.top).toBe('256px')
    expect(panel.style.getPropertyValue('--fm-filter-max-height')).toBe('504px')
    expect(sidecar.style.top).toBe('-96px')
    expect(sidecar.style.maxHeight).toBe('752px')
  })

  it.each(['search', 'selection'] as const)('locks an inactive range after %s starts first', (action) => {
    mountColorOptions()
    const search = document.querySelector<HTMLInputElement>('.fm-header-filter-search')!
    if (action === 'search') {
      search.value = 'red'
      search.dispatchEvent(new Event('input', { bubbles: true }))
    } else {
      document.querySelector<HTMLInputElement>('[data-value="Red"]')!.click()
    }

    expect(document.querySelector('.fm-header-color-disclosure')?.classList.contains('is-locked')).toBe(true)
    document.querySelector<HTMLButtonElement>('[data-clear-list-filter]')!.click()
    expect(search.value).toBe('')
    expect(document.querySelector('.fm-header-color-disclosure')?.classList.contains('is-locked')).toBe(false)
  })

  it('filters candidates live when the range activates first and still allows text refinement', () => {
    mountColorOptions()
    document.querySelector<HTMLButtonElement>('[data-color-preset="red"]')!.click()
    expect([...document.querySelectorAll<HTMLInputElement>('[data-value]')].map((input) => input.dataset.value))
      .toEqual(['Red'])

    const search = document.querySelector<HTMLInputElement>('.fm-header-filter-search')!
    search.value = 'missing'
    search.dispatchEvent(new Event('input', { bubbles: true }))
    expect(document.querySelector('.fm-header-filter-empty-text')).not.toBeNull()

    document.querySelector<HTMLButtonElement>('[data-clear-color-range]')!.click()
    expect(document.querySelector('[data-color-mode="color"]')?.getAttribute('aria-pressed')).toBe('false')
  })

  it('activates an inactive color range and centers it where the wheel is clicked', () => {
    mountColorOptions()
    const wheel = document.querySelector<HTMLElement>('.fm-header-color-wheel')!
    vi.spyOn(wheel, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 180, height: 180 } as DOMRect)

    wheel.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 180, clientY: 90, pointerId: 1 }))
    wheel.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 }))

    expect(document.querySelector('[data-color-mode="color"]')?.getAttribute('aria-pressed')).toBe('true')
    expect(document.querySelector('.fm-header-color-controls')?.classList.contains('is-inactive')).toBe(false)
    expect([
      document.querySelector<HTMLInputElement>('[data-color-field="hueFrom"]')?.value,
      document.querySelector<HTMLInputElement>('[data-color-field="hueTo"]')?.value,
    ]).toEqual(['343', '18'])
    expect([...document.querySelectorAll<HTMLInputElement>('[data-value]')].map(input => input.dataset.value))
      .toEqual(['Red'])
  })

  it.each([
    { action: 'checked', expected: ['Red'] },
    { action: 'text', expected: ['Red'] },
    { action: 'range', expected: ['Red'] },
    { action: 'unfiltered', expected: [] },
  ] as const)('applies $action color values once', ({ action, expected }) => {
    const { onApply } = mountColorOptions()
    if (action === 'checked') document.querySelector<HTMLInputElement>('[data-value="Red"]')!.click()
    if (action === 'text') {
      const search = document.querySelector<HTMLInputElement>('.fm-header-filter-search')!
      search.value = 'red'
      search.dispatchEvent(new Event('input', { bubbles: true }))
    }
    if (action === 'range') document.querySelector<HTMLButtonElement>('[data-color-preset="red"]')!.click()

    document.querySelector<HTMLButtonElement>('.fm-header-filter-actions .fm-btn-primary')!.click()
    expect(onApply).toHaveBeenCalledTimes(1)
    expect(onApply).toHaveBeenCalledWith({ type: 'multi', values: expected })
  })

  it('keeps the indicator applied-only and discards staged choices when closed', () => {
    const { onApply } = mountColorOptions()
    const trigger = document.querySelector<HTMLButtonElement>('.fm-header-filter-trigger')!
    document.querySelector<HTMLInputElement>('[data-value="Red"]')!.click()
    expect(trigger.classList.contains('pending')).toBe(false)

    document.body.click()
    trigger.click()
    expect(document.querySelector<HTMLInputElement>('[data-value="Red"]')!.checked).toBe(false)
    expect(onApply).not.toHaveBeenCalled()
  })

  it('applies visible colors with Enter', () => {
    const { onApply } = mountColorOptions()
    const search = document.querySelector<HTMLInputElement>('.fm-header-filter-search')!
    search.value = 'red'
    search.dispatchEvent(new Event('input', { bubbles: true }))
    search.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }))
    expect(onApply).toHaveBeenCalledWith({ type: 'multi', values: ['Red'] })
  })

  it('uses neutral and ROYGBIV presets while keeping their ranges editable', () => {
    document.body.innerHTML = '<button id="color-filter">Filter colors</button>'
    const onApply = vi.fn()
    const trigger = document.querySelector<HTMLButtonElement>('#color-filter')!
    bindColorFilterButton(trigger, onApply)
    trigger.click()
    const hueFrom = document.querySelector<HTMLInputElement>('[data-color-field="hueFrom"]')!
    const hueTo = document.querySelector<HTMLInputElement>('[data-color-field="hueTo"]')!
    const saturationFrom = document.querySelector<HTMLInputElement>('[data-color-field="saturationFrom"]')!
    const saturationTo = document.querySelector<HTMLInputElement>('[data-color-field="saturationTo"]')!
    const valueFrom = document.querySelector<HTMLInputElement>('[data-color-field="valueFrom"]')!
    const valueTo = document.querySelector<HTMLInputElement>('[data-color-field="valueTo"]')!
    const valuePreview = document.querySelector<HTMLInputElement>('[data-color-field="valuePreview"]')!
    const transparent = document.querySelector<HTMLInputElement>('[data-color-transparent]')!
    const color = document.querySelector<HTMLButtonElement>('[data-color-mode="color"]')!
    const red = document.querySelector<HTMLButtonElement>('[data-color-preset="red"]')!
    const green = document.querySelector<HTMLButtonElement>('[data-color-preset="green"]')!
    const black = document.querySelector<HTMLButtonElement>('[data-color-neutral="black"]')!
    const white = document.querySelector<HTMLButtonElement>('[data-color-neutral="white"]')!
    const grey = document.querySelector<HTMLButtonElement>('[data-color-neutral="grey"]')!
    color.click()
    expect(hueFrom.type).toBe('range')
    expect(hueFrom.parentElement).toBe(hueTo.parentElement)
    expect(hueFrom.parentElement?.classList.contains('fm-header-color-dual-range')).toBe(true)
    expect([hueFrom.min, hueFrom.max, hueTo.min, hueTo.max]).toEqual(['0', '360', '0', '360'])
    expect(saturationFrom.type).toBe('range')
    expect(valueTo.type).toBe('range')
    expect(valuePreview.type).toBe('range')
    expect(valuePreview.parentElement).toBe(valueTo.parentElement)
    expect(valuePreview.classList.contains('fm-header-color-preview-range')).toBe(true)
    const previewGrab = document.querySelector<HTMLElement>('.fm-header-color-preview-grab')!
    expect(previewGrab.querySelector('svg')).not.toBeNull()
    expect(previewGrab.getAttribute('aria-hidden')).toBe('true')
    expect(document.querySelector('.fm-header-color-title')?.textContent).toBe('Color filter')
    expect(color.querySelector('.fm-header-color-wheel-icon')).not.toBeNull()
    expect(color.getAttribute('aria-pressed')).toBe('true')
    expect([...document.querySelectorAll<HTMLButtonElement>('[data-color-preset], [data-color-neutral]')]
      .map((button) => button.textContent)).toEqual([
      'Black', 'Grey', 'White', 'Red', 'Orange', 'Yellow', 'Green', 'Blue', 'Indigo', 'Violet',
    ])
    expect(red.getAttribute('aria-pressed')).toBe('false')
    expect([...document.querySelectorAll<HTMLInputElement>('[data-color-field]')].every((input) => !input.disabled)).toBe(true)
    expect([black.type, white.type, grey.type]).toEqual(['button', 'button', 'button'])
    expect(transparent.type).toBe('checkbox')
    expect(transparent.parentElement?.textContent).toContain('Include transparent hex')
    expect(document.querySelector('.fm-header-color-wheel')).not.toBeNull()

    red.click()
    expect(red.getAttribute('aria-pressed')).toBe('true')
    expect([hueFrom.value, hueTo.value]).toEqual(['320', '15'])
    expect([...document.querySelectorAll<HTMLInputElement>('[data-color-field]')].every((input) => !input.disabled)).toBe(true)

    black.click()
    expect(black.getAttribute('aria-pressed')).toBe('true')
    expect(red.getAttribute('aria-pressed')).toBe('false')
    expect(document.querySelector<HTMLElement>('.fm-header-color-wheel-selection')!.hidden).toBe(false)
    expect(hueFrom.disabled).toBe(true)
    expect(saturationFrom.disabled).toBe(true)
    expect(valueTo.disabled).toBe(false)
    expect(document.querySelector('[data-color-range-label="saturationFrom"]')?.textContent).toBe('Color tolerance')
    expect(document.querySelector('[data-color-output="saturationFrom"]')?.closest('.fm-header-color-range')?.classList.contains('is-muted')).toBe(false)
    expect(document.querySelector('[data-color-output="valueFrom"]')?.closest('.fm-header-color-range')?.classList.contains('is-muted')).toBe(false)
    white.click()
    expect(black.getAttribute('aria-pressed')).toBe('false')
    expect(white.getAttribute('aria-pressed')).toBe('true')
    white.click()
    expect(white.getAttribute('aria-pressed')).toBe('true')
    grey.click()
    expect(grey.getAttribute('aria-pressed')).toBe('true')
    green.click()
    expect(grey.getAttribute('aria-pressed')).toBe('false')
    expect(green.getAttribute('aria-pressed')).toBe('true')
    expect([hueFrom.value, hueTo.value]).toEqual(['90', '180'])
    expect(document.querySelector('[data-color-range-label="saturationFrom"]')?.textContent).toBe('Saturation range')

    const hueReset = document.querySelector<HTMLButtonElement>('[data-color-range-reset="hueFrom"]')!
    const saturationReset = document.querySelector<HTMLButtonElement>('[data-color-range-reset="saturationFrom"]')!
    const valueReset = document.querySelector<HTMLButtonElement>('[data-color-range-reset="valueFrom"]')!
    hueFrom.value = '120'
    hueFrom.dispatchEvent(new Event('input', { bubbles: true }))
    saturationFrom.value = '40'
    saturationFrom.dispatchEvent(new Event('input', { bubbles: true }))
    valueTo.value = '75'
    valueTo.dispatchEvent(new Event('input', { bubbles: true }))
    hueReset.click()
    expect([hueFrom.value, hueTo.value]).toEqual(['10', '45'])
    expect([saturationFrom.value, saturationTo.value]).toEqual(['40', '100'])
    saturationReset.click()
    expect([saturationFrom.value, saturationTo.value]).toEqual(['10', '100'])
    expect(valueTo.value).toBe('75')
    valueReset.click()
    expect([valueFrom.value, valueTo.value, valuePreview.value]).toEqual(['16', '100', '100'])
    expect(document.querySelector<HTMLElement>('.fm-header-color-wheel-selection')!.hidden).toBe(false)
    expect([...document.querySelectorAll<HTMLInputElement>('[data-color-field]')].every((input) => !input.disabled)).toBe(true)

    hueFrom.value = '330'
    hueFrom.dispatchEvent(new Event('input', { bubbles: true }))
    expect(hueFrom.value).toBe('45')
    expect(grey.getAttribute('aria-pressed')).toBe('false')
    hueFrom.value = '30'
    hueFrom.dispatchEvent(new Event('input', { bubbles: true }))
    hueTo.value = '20'
    hueTo.dispatchEvent(new Event('input', { bubbles: true }))
    expect(hueTo.value).toBe('30')
    hueTo.value = '45'
    hueTo.dispatchEvent(new Event('input', { bubbles: true }))
    expect([hueFrom.min, hueFrom.max, hueTo.min, hueTo.max]).toEqual(['0', '360', '0', '360'])
    const wheel = document.querySelector<HTMLElement>('.fm-header-color-wheel')!
    expect(wheel.style.getPropertyValue('--color-hue-from')).toBe('45deg')
    expect(wheel.style.getPropertyValue('--color-hue-span')).toBe('15deg')
    saturationFrom.value = '40'
    saturationFrom.dispatchEvent(new Event('input', { bubbles: true }))
    valueTo.value = '75'
    valueTo.dispatchEvent(new Event('input', { bubbles: true }))
    expect(valuePreview.value).toBe('75')
    valuePreview.value = '60'
    valuePreview.dispatchEvent(new Event('input', { bubbles: true }))
    expect(wheel.style.getPropertyValue('--color-wheel-darkness')).toBe('0.4')
    transparent.click()
    valuePreview.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }))

    expect(onApply).toHaveBeenCalledWith({
      type: 'color',
      mode: 'color',
      hueFrom: 30,
      hueTo: 45,
      saturationFrom: 40,
      saturationTo: 100,
      valueFrom: 16,
      valueTo: 75,
      valuePreview: 60,
      includeTransparent: true,
    })
  })

  it('shows, edits, and resets neutral brightness and tint presets', () => {
    document.body.innerHTML = '<button id="color-filter">Filter colors</button>'
    const trigger = document.querySelector<HTMLButtonElement>('#color-filter')!
    bindColorFilterButton(trigger, vi.fn())
    trigger.click()
    const wheel = document.querySelector<HTMLElement>('.fm-header-color-wheel')!
    const surface = document.querySelector<HTMLElement>('.fm-header-color-wheel-surface')!
    const selection = document.querySelector<HTMLElement>('.fm-header-color-wheel-selection')!
    const hueFrom = document.querySelector<HTMLInputElement>('[data-color-field="hueFrom"]')!
    const saturationFrom = document.querySelector<HTMLInputElement>('[data-color-field="saturationFrom"]')!
    const saturationTo = document.querySelector<HTMLInputElement>('[data-color-field="saturationTo"]')!
    const valueFrom = document.querySelector<HTMLInputElement>('[data-color-field="valueFrom"]')!
    const valueTo = document.querySelector<HTMLInputElement>('[data-color-field="valueTo"]')!
    const valuePreview = document.querySelector<HTMLInputElement>('[data-color-field="valuePreview"]')!
    const hueReset = document.querySelector<HTMLButtonElement>('[data-color-range-reset="hueFrom"]')!
    const saturationReset = document.querySelector<HTMLButtonElement>('[data-color-range-reset="saturationFrom"]')!
    const valueReset = document.querySelector<HTMLButtonElement>('[data-color-range-reset="valueFrom"]')!

    document.querySelector<HTMLButtonElement>('[data-color-neutral="black"]')!.click()
    expect(wheel.classList.contains('is-neutral')).toBe(true)
    expect(wheel.dataset.neutralMode).toBe('black')
    expect(surface.hidden).toBe(false)
    expect(selection.hidden).toBe(false)
    expect([valueFrom.value, valueTo.value]).toEqual(['0', '15'])
    expect([saturationFrom.value, saturationTo.value]).toEqual(['0', '20'])
    expect([hueFrom.disabled, saturationFrom.disabled, valueFrom.disabled, valueTo.disabled, valuePreview.disabled])
      .toEqual([true, true, false, false, true])
    expect(saturationTo.disabled).toBe(false)
    expect(wheel.style.getPropertyValue('--color-neutral-saturation')).toBe('0.2')
    expect(hueReset.hidden).toBe(true)
    expect(saturationReset.hidden).toBe(false)
    expect(valueReset.hidden).toBe(false)

    saturationTo.value = '14'
    saturationTo.dispatchEvent(new Event('input', { bubbles: true }))
    valueTo.value = '22'
    valueTo.dispatchEvent(new Event('input', { bubbles: true }))
    expect(document.querySelector('[data-color-neutral="black"]')?.getAttribute('aria-pressed')).toBe('true')
    expect(document.querySelector<HTMLOutputElement>('[data-color-output="saturationFrom"]')?.textContent).toBe('0%–14%')
    expect(document.querySelector<HTMLOutputElement>('[data-color-output="valueFrom"]')?.textContent).toBe('0%–22%')
    saturationReset.click()
    expect([saturationFrom.value, saturationTo.value]).toEqual(['0', '20'])
    expect([valueFrom.value, valueTo.value]).toEqual(['0', '22'])
    valueReset.click()
    expect([valueFrom.value, valueTo.value]).toEqual(['0', '15'])

    document.querySelector<HTMLButtonElement>('[data-color-neutral="grey"]')!.click()
    expect([valueFrom.value, valueTo.value]).toEqual(['35', '65'])
    document.querySelector<HTMLButtonElement>('[data-color-neutral="white"]')!.click()
    expect([valueFrom.value, valueTo.value]).toEqual(['85', '100'])

    document.querySelector<HTMLButtonElement>('[data-color-preset="orange"]')!.click()
    expect(wheel.classList.contains('is-neutral')).toBe(false)
    expect(surface.hidden).toBe(false)
    expect([saturationFrom.value, saturationTo.value, valueFrom.value, valueTo.value]).toEqual(['10', '100', '16', '100'])
    expect([hueReset.hidden, saturationReset.hidden, valueReset.hidden]).toEqual([false, false, false])
  })

  it.each([
    ['hueFrom', '50'],
    ['saturationFrom', '20'],
    ['valueTo', '80'],
  ])('switches a named chromatic preset to Color when %s is adjusted', (field, next) => {
    document.body.innerHTML = '<button id="color-filter">Filter colors</button>'
    bindColorFilterButton(document.querySelector<HTMLButtonElement>('#color-filter')!, vi.fn())
    document.querySelector<HTMLButtonElement>('#color-filter')!.click()
    const color = document.querySelector<HTMLButtonElement>('[data-color-mode="color"]')!
    const yellow = document.querySelector<HTMLButtonElement>('[data-color-preset="yellow"]')!
    yellow.click()

    const input = document.querySelector<HTMLInputElement>(`[data-color-field="${field}"]`)!
    input.value = next
    input.dispatchEvent(new Event('input', { bubbles: true }))

    expect(yellow.getAttribute('aria-pressed')).toBe('false')
    expect(color.getAttribute('aria-pressed')).toBe('true')
  })

  it('moves the complete hue arc from the wheel and its middle grab handle', () => {
    document.body.innerHTML = '<button id="color-filter">Filter colors</button>'
    const trigger = document.querySelector<HTMLButtonElement>('#color-filter')!
    bindColorFilterButton(trigger, vi.fn())
    trigger.click()
    const color = document.querySelector<HTMLButtonElement>('[data-color-mode="color"]')!
    const yellow = document.querySelector<HTMLButtonElement>('[data-color-preset="yellow"]')!
    yellow.click()
    const wheel = document.querySelector<HTMLElement>('.fm-header-color-wheel')!
    const hueFrom = document.querySelector<HTMLInputElement>('[data-color-field="hueFrom"]')!
    const hueTo = document.querySelector<HTMLInputElement>('[data-color-field="hueTo"]')!
    const grab = document.querySelector<HTMLElement>('[data-color-grab="hue"]')!
    const slider = grab.parentElement!
    expect(grab.getAttribute('role')).toBe('slider')
    expect(grab.querySelectorAll('.fm-header-color-range-grab-dot')).toHaveLength(3)
    expect(grab.textContent).toBe('')
    expect(grab.style.left).toBe('calc(18.7500% + 5.3125px)')
    vi.spyOn(wheel, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 180, height: 180 } as DOMRect)
    vi.spyOn(slider, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 360, height: 20 } as DOMRect)

    wheel.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 0, clientY: 90, pointerId: 1 }))
    expect([hueFrom.value, hueTo.value]).toEqual(['158', '203'])
    expect(yellow.getAttribute('aria-pressed')).toBe('false')
    expect(color.getAttribute('aria-pressed')).toBe('true')
    wheel.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 90, clientY: 180, pointerId: 1 }))
    wheel.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 }))
    expect([hueFrom.value, hueTo.value]).toEqual(['248', '293'])

    grab.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 270, pointerId: 2 }))
    grab.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 290, pointerId: 2 }))
    grab.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 2 }))
    expect([hueFrom.value, hueTo.value]).toEqual(['269', '314'])
    grab.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowRight' }))
    expect([hueFrom.value, hueTo.value]).toEqual(['270', '315'])
    grab.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 270, pointerId: 4 }))
    grab.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: -1102, pointerId: 4 }))
    grab.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 4 }))
    expect([hueFrom.value, hueTo.value]).toEqual(['270', '315'])

    wheel.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 180, clientY: 90, pointerId: 3 }))
    wheel.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 3 }))
    expect([hueFrom.value, hueTo.value]).toEqual(['338', '23'])
    expect(grab.hidden).toBe(true)
    hueFrom.value = '350'
    hueFrom.dispatchEvent(new Event('input', { bubbles: true }))
    hueTo.value = '25'
    hueTo.dispatchEvent(new Event('input', { bubbles: true }))
    expect([hueFrom.value, hueTo.value]).toEqual(['350', '25'])
  })

  it('keeps a full hue circle intact when its midpoint control moves', () => {
    document.body.innerHTML = '<button id="color-filter">Filter colors</button>'
    const trigger = document.querySelector<HTMLButtonElement>('#color-filter')!
    bindColorFilterButton(trigger, vi.fn())
    trigger.click()
    document.querySelector<HTMLButtonElement>('[data-color-mode="color"]')!.click()
    const hueFrom = document.querySelector<HTMLInputElement>('[data-color-field="hueFrom"]')!
    const hueTo = document.querySelector<HTMLInputElement>('[data-color-field="hueTo"]')!
    hueFrom.value = '0'
    hueFrom.dispatchEvent(new Event('input', { bubbles: true }))
    hueTo.value = '360'
    hueTo.dispatchEvent(new Event('input', { bubbles: true }))
    const grab = document.querySelector<HTMLElement>('[data-color-grab="hue"]')!
    vi.spyOn(grab.parentElement!, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 360, height: 20 } as DOMRect)
    grab.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 180, pointerId: 1 }))
    grab.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 200, pointerId: 1 }))
    expect([
      hueFrom.value,
      hueTo.value,
    ]).toEqual(['0', '360'])
  })

})
