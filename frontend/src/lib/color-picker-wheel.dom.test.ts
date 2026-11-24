// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { bindColorPickerPopup, bindColorPickerWheel, hsvHex } from './color-picker-wheel'
import { bindAlphaColorControls } from './colors'
import { sampleNeutralWheelColor } from './color-wheel'

vi.mock('./color-wheel', async importOriginal => ({
  ...await importOriginal<typeof import('./color-wheel')>(),
  sampleNeutralWheelColor: vi.fn(() => '#FFFFFF'),
  neutralWheelPalette: vi.fn(() => ({ background: 'none' })),
}))

afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = ''; vi.mocked(sampleNeutralWheelColor).mockReset().mockReturnValue('#FFFFFF') })
it('converts HSV endpoints and wrapped hues without losing channel precision', () => {
  expect(hsvHex(0, 100, 100)).toBe('#FF0000')
  expect(hsvHex(180, 100, 100)).toBe('#00FFFF')
  expect(hsvHex(360, 100, 100)).toBe('#FF0000')
  expect(hsvHex(270, 0, 50)).toBe('#808080')
  expect(hsvHex(60, 100, 0)).toBe('#000000')
})
it('keeps current picker, hex and wheel synchronized with exact alpha across toggles', () => {
  document.body.innerHTML = `<form><input id="hex" value="#FF000080"><input id="picker" type="color"><input id="enabled" type="checkbox"><div id="options"></div><span id="preview"></span><input id="alpha"><input id="value"><input id="alphaHex"><details><summary>Wheel</summary></details></form>`
  const input = (id: string) => document.getElementById(id) as HTMLInputElement
  const controls = bindAlphaColorControls({ picker: input('picker'), hexInput: input('hex'), alphaEnabled: input('enabled'), alphaOptions: document.getElementById('options')!, alphaPreview: document.getElementById('preview')!, alphaInput: input('alpha'), alphaValueInput: input('value'), alphaHexInput: input('alphaHex') })
  controls.syncFromHex()
  const details = document.querySelector('details')!
  bindColorPickerWheel(details, input('hex'), new AbortController().signal)
  const hue = details.querySelector<HTMLInputElement>('[data-wheel-hue]')!
  hue.value = '120'; hue.dispatchEvent(new Event('input', { bubbles: true }))
  expect(input('hex').value).toBe('#00FF0080')
  expect(input('picker').value.toUpperCase()).toBe('#00FF00')
  expect(details.querySelector('[data-wheel-complement]')!.textContent).toBe('#FF00FF80')
  details.open = true; details.dispatchEvent(new Event('toggle'))
  details.open = false; details.dispatchEvent(new Event('toggle'))
  expect(input('hex').value).toBe('#00FF0080')
  input('picker').value = '#0000ff'; input('picker').dispatchEvent(new Event('input', { bubbles: true }))
  expect(hue.value).toBe('240')
  input('hex').value = '#ABCDEF23'; input('hex').dispatchEvent(new Event('input', { bubbles: true }))
  expect(details.querySelector('[data-wheel-complement]')!.textContent).toMatch(/23$/)
})

it('returns from a neutral draft to color and keeps neutral brightness adjustments grayscale', () => {
  document.body.innerHTML = '<form><input id="hex" value="#000000"><details></details></form>'
  const details = document.querySelector('details')!, hex = document.querySelector('input')!
  bindColorPickerWheel(details, hex, new AbortController().signal)
  const hue = details.querySelector<HTMLInputElement>('[data-wheel-hue]')!
  const saturation = details.querySelector<HTMLInputElement>('[data-wheel-saturation]')!
  const brightness = details.querySelector<HTMLInputElement>('[data-wheel-brightness]')!
  details.querySelector<HTMLButtonElement>('[data-wheel-color]')!.click()
  hue.value = '120'; hue.dispatchEvent(new Event('input', { bubbles: true }))
  saturation.value = '100'; saturation.dispatchEvent(new Event('input', { bubbles: true }))
  expect(hue.value).toBe('120')
  expect(saturation.value).toBe('100')
  brightness.value = '100'; brightness.dispatchEvent(new Event('input', { bubbles: true }))
  expect(hex.value).toBe('#00FF00')
  details.querySelector<HTMLButtonElement>('[data-color-neutral="grey"]')!.click()
  expect(hue.value).toBe('120')
  expect(hue.disabled).toBe(false)
  brightness.value = '25'; brightness.dispatchEvent(new Event('input', { bubbles: true }))
  expect(hex.value).toBe('#5A5A5A')
  details.querySelector<HTMLButtonElement>('[data-wheel-color]')!.click()
  expect(hex.value).toBe('#00FF00')
  details.querySelector<HTMLButtonElement>('[data-color-neutral="grey"]')!.click()
  hue.value = '240'; hue.dispatchEvent(new Event('input', { bubbles: true }))
  saturation.value = '10'; saturation.dispatchEvent(new Event('input', { bubbles: true }))
  expect(hex.value).toBe('#737380')
  expect(Math.round(Number(brightness.value))).toBe(50)
})

it('keeps the original native picker in the form and adds a synchronized optional wheel', async () => {
  const { bindColorPickerPopup } = await import('./color-picker-wheel')
  document.body.innerHTML = `<section><form><input id="hex" value="#12345680"><input id="enabled" type="checkbox"><div id="options"></div><span id="preview"></span><input id="alpha"><input id="value"><input id="alphaHex"><input id="picker" type="color"><div id="popup" popover><button type="button" data-wheel-cancel>Cancel</button><section data-color-picker-wheel></section></div></form></section>`
  const input = (id: string) => document.getElementById(id) as HTMLInputElement
  const controls = bindAlphaColorControls({ picker: input('picker'), hexInput: input('hex'), alphaEnabled: input('enabled'), alphaOptions: document.getElementById('options')!, alphaPreview: document.getElementById('preview')!, alphaInput: input('alpha'), alphaValueInput: input('value'), alphaHexInput: input('alphaHex') })
  controls.syncFromHex()
  const popup = document.getElementById('popup')!
  const binding = bindColorPickerPopup(popup, input('hex'), new AbortController().signal)
  expect(input('picker').closest('form')).toBe(input('hex').closest('form'))
  expect(popup.closest('form')).toBeNull()
  input('picker').value = '#ff3456'; input('picker').dispatchEvent(new Event('input', { bubbles: true }))
  expect(input('hex').value).toBe('#FF345680')
  const hue = popup.querySelector<HTMLInputElement>('[data-wheel-hue]')!
  hue.value = '120'; hue.dispatchEvent(new Event('input', { bubbles: true }))
  expect(input('hex').value).toBe('#34FF3480')
  expect(input('picker').value.toUpperCase()).toBe('#34FF34')
  expect(popup.querySelector('[data-wheel-complement]')!.textContent).toBe('#FF34FF80')
  input('hex').value = '#000000'; controls.syncFromHex(); binding.reset()
  expect(input('picker').value).toBe('#000000')
  expect(popup.querySelector<HTMLInputElement>('[data-wheel-brightness]')!.value).toBe('0')
  input('hex').value = '#12345623'; controls.syncFromHex(); binding.reset()
  popup.dispatchEvent(Object.assign(new Event('beforetoggle'), { newState: 'open' }))
  const editor = popup.querySelector<HTMLInputElement>('[data-wheel-hex]')!
  editor.value = '#ABCDEF80'; editor.dispatchEvent(new Event('input', { bubbles: true }))
  popup.querySelector<HTMLButtonElement>('[data-wheel-cancel]')!.click()
  expect(input('hex').value).toBe('#12345623')
  expect(input('alphaHex').value).toBe('23')
  expect(input('picker').value.toUpperCase()).toBe('#123456')
  input('hex').value = '#12'; input('hex').dispatchEvent(new Event('input', { bubbles: true }))
  expect(editor.value).toBe('#12')
  expect(editor.getAttribute('aria-invalid')).toBe('true')
  popup.dispatchEvent(Object.assign(new Event('beforetoggle'), { newState: 'open' }))
  editor.value = '#FF000080'; editor.dispatchEvent(new Event('input', { bubbles: true }))
  popup.querySelector<HTMLButtonElement>('[data-wheel-cancel]')!.click()
  expect(input('hex').value).toBe('#12')
  expect(editor.value).toBe('#12')
  expect(input('alphaHex').value).toBe('23')

})

it('shows the selected hex in the popup and applies neutral shortcuts without changing opacity', () => {
  document.body.innerHTML = '<form><input value="#12345623"><section></section></form>'
  const hex = document.querySelector('input')!, panel = document.querySelector('section')!
  bindColorPickerWheel(panel, hex, undefined)
  const readout = () => panel.querySelector<HTMLInputElement>('[data-wheel-hex]')!.value
  expect(readout()).toBe('#12345623')
  for (const [neutral, expected] of [['white', '#FFFFFF23'], ['grey', '#80808023'], ['black', '#00000023']]) {
    panel.querySelector<HTMLButtonElement>(`[data-color-neutral="${neutral}"]`)!.click()
    expect(hex.value).toBe(expected)
    expect(readout()).toBe(expected)
  }
  panel.querySelector<HTMLButtonElement>('[data-wheel-color]')!.click()
  expect(readout()).toBe('#12345623')
  hex.value = '#12'; hex.dispatchEvent(new Event('input', { bubbles: true }))
  panel.querySelector<HTMLButtonElement>('[data-color-neutral="white"]')!.click()
  expect(readout()).toBe('#FFFFFF23')
  panel.querySelector<HTMLButtonElement>('[data-color-neutral="black"]')!.click()
  const wheel = panel.querySelector<HTMLElement>('.fm-header-color-wheel')!
  expect(wheel.classList.contains('is-neutral')).toBe(true)
  expect(panel.querySelector<HTMLInputElement>('[data-wheel-hue]')!.disabled).toBe(false)
  wheel.getBoundingClientRect = () => ({ left: 0, top: 0, width: 180, height: 180 }) as DOMRect
  wheel.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: 180, clientY: 90 }))
  expect(hex.value).toBe('#00000023')
  expect(readout()).toBe('#00000023')
  panel.querySelector<HTMLButtonElement>('[data-wheel-color]')!.click()
  expect(readout()).toBe('#12345623')
  expect(wheel.classList.contains('is-neutral')).toBe(false)
  expect(panel.querySelector<HTMLInputElement>('[data-wheel-hue]')!.disabled).toBe(false)
  wheel.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: 180, clientY: 90 }))
  expect(readout()).toBe('#56000023')
  const brightness = panel.querySelector<HTMLInputElement>('[data-wheel-brightness]')!
  brightness.value = '50'; brightness.dispatchEvent(new Event('input'))
  expect(readout()).toBe('#80000023')
})


it('keeps Color mode stable when pressing and releasing the achromatic center', () => {
  document.body.innerHTML = '<form><input value="#4A90E223"><section></section></form>'
  const hex = document.querySelector('input')!, panel = document.querySelector('section')!
  bindColorPickerWheel(panel, hex, undefined)
  const wheel = panel.querySelector<HTMLElement>('.fm-header-color-wheel')!
  wheel.getBoundingClientRect = () => ({ left: 0, top: 0, width: 180, height: 180 }) as DOMRect
  wheel.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: 90, clientY: 90 }))
  expect(hex.value).toBe('#E2E2E223')
  wheel.dispatchEvent(new PointerEvent('pointerup', { button: 0, clientX: 90, clientY: 90 }))
  expect(hex.value).toBe('#E2E2E223')
  expect(wheel.classList.contains('is-neutral')).toBe(false)
  expect(panel.querySelector<HTMLInputElement>('[data-wheel-saturation]')!.disabled).toBe(false)
  const brightness = panel.querySelector<HTMLInputElement>('[data-wheel-brightness]')!
  brightness.value = '0'; brightness.dispatchEvent(new Event('input'))
  expect(wheel.style.getPropertyValue('--color-wheel-darkness')).toBe('1')
  wheel.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: 180, clientY: 90 }))
  expect(hex.value).toBe('#00000023')
  expect(wheel.classList.contains('is-neutral')).toBe(false)
})

it('edits hex bidirectionally and selects the complementary color with exact alpha', () => {
  document.body.innerHTML = '<form><input id="main-hex" value="#FF000023"><section></section></form>'
  const hex = document.querySelector('input')!, panel = document.querySelector('section')!
  bindColorPickerWheel(panel, hex, undefined)
  const editor = panel.querySelector<HTMLInputElement>('[data-wheel-hex]')!
  expect(editor.required).toBe(false)
  expect(editor.hasAttribute('pattern')).toBe(false)
  expect(editor.value).toBe('#FF000023')
  editor.value = '#12'; editor.dispatchEvent(new Event('input', { bubbles: true }))
  expect(hex.value).toBe('#12')
  expect(editor.getAttribute('aria-invalid')).toBe('true')
  editor.value = '#00ff0023'; editor.dispatchEvent(new Event('input', { bubbles: true }))
  expect(hex.value).toBe('#00FF0023')
  expect(editor.value).toBe('#00ff0023')
  panel.querySelector<HTMLButtonElement>('[data-select-complement]')!.click()
  expect(hex.value).toBe('#FF00FF23')
  expect(editor.value).toBe('#FF00FF23')
  expect(panel.querySelector('[data-wheel-complement]')!.textContent).toBe('#00FF0023')
  expect(panel.querySelectorAll('.filament-color-dot')).toHaveLength(2)
})


it('keeps each tinted neutral palette stable through a complete pointer gesture', () => {
  for (const [mode, tolerance] of [['black', 20], ['grey', 10], ['white', 10]] as const) {
    document.body.innerHTML = '<form><input value="#12345623"><section></section></form>'
    const hex = document.querySelector('input')!, panel = document.querySelector('section')!
    bindColorPickerWheel(panel, hex, undefined)
    panel.querySelector<HTMLButtonElement>(`[data-color-neutral="${mode}"]`)!.click()
    const wheel = panel.querySelector<HTMLElement>('.fm-header-color-wheel')!
    expect(wheel.style.getPropertyValue('--color-neutral-saturation')).toBe(String(tolerance / 100))
    wheel.getBoundingClientRect = () => ({ left: 0, top: 0, width: 180, height: 180 }) as DOMRect
    const chosen = { black: '#151012', grey: '#897C7C', white: '#F1E8E8' }[mode]
    vi.mocked(sampleNeutralWheelColor).mockReturnValue(chosen)
    wheel.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: 130, clientY: 60 }))
    wheel.dispatchEvent(new PointerEvent('pointerup', { button: 0, clientX: 130, clientY: 60 }))
    expect(hex.value).toBe(chosen + '23')
    expect(wheel.dataset.neutralMode).toBe(mode)
    panel.querySelector<HTMLButtonElement>('[data-wheel-color]')!.click()
    expect(hex.value).toBe('#12345623')
  }
})


it('marks and enforces the search brightness bands, with unrestricted Color mode', () => {
  document.body.innerHTML = '<form><input value="#12345623"><section></section></form>'
  const hex = document.querySelector('input')!, panel = document.querySelector('section')!
  bindColorPickerWheel(panel, hex, undefined)
  const brightness = panel.querySelector<HTMLInputElement>('[data-wheel-brightness]')!
  for (const [mode, min, max] of [['black', 0, 20], ['grey', 35, 65], ['white', 80, 100]] as const) {
    panel.querySelector<HTMLButtonElement>(`[data-color-neutral="${mode}"]`)!.click()
    expect(brightness.getAttribute('aria-valuemin')).toBe(String(min))
    expect(brightness.getAttribute('aria-valuemax')).toBe(String(max))
    expect(brightness.parentElement!.style.getPropertyValue('--color-range-low')).toBe(`${min}%`)
    expect(brightness.parentElement!.style.getPropertyValue('--color-range-high')).toBe(`${max}%`)
    brightness.value = '0'; brightness.dispatchEvent(new Event('input'))
    expect(Number(brightness.value)).toBeCloseTo(Math.ceil(min * 255 / 100) / 255 * 100, 2)
    brightness.value = '100'; brightness.dispatchEvent(new Event('input'))
    expect(Number(brightness.value)).toBeCloseTo(Math.floor(max * 255 / 100) / 255 * 100, 2)
    const wheel = panel.querySelector<HTMLElement>('.fm-header-color-wheel')!
    wheel.getBoundingClientRect = () => ({ left: 0, top: 0, width: 180, height: 180 }) as DOMRect
    const chosen = { black: '#151012', grey: '#897C7C', white: '#F1E8E8' }[mode]
    vi.mocked(sampleNeutralWheelColor).mockReturnValue(chosen)
    for (const clientX of [92, 160]) {
      wheel.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX, clientY: 90 }))
      expect(hex.value).toBe(chosen + '23')
      expect(wheel.dataset.neutralMode).toBe(mode)
    }
  }
  panel.querySelector<HTMLButtonElement>('[data-wheel-color]')!.click()
  expect(brightness.getAttribute('aria-valuemin')).toBe('0')
  expect(brightness.getAttribute('aria-valuemax')).toBe('100')
  expect(panel.querySelector('[data-color-window]')).toBeNull()
})


it('reconciles typed and loaded grays to the search brightness bands without changing their hex', () => {
  for (const [value, mode] of [['#0A0A0A23', 'black'], ['#80808023', 'grey'], ['#EFEFEF23', 'white'], ['#55555523', null], ['#B0B0B023', null]]) {
    document.body.innerHTML = `<form><input value="${value}"><section></section></form>`
    const hex = document.querySelector('input')!, panel = document.querySelector('section')!
    bindColorPickerWheel(panel, hex, undefined)
    const wheel = panel.querySelector<HTMLElement>('.fm-header-color-wheel')!
    expect(wheel.dataset.neutralMode ?? null).toBe(mode)
    panel.querySelector<HTMLButtonElement>('[data-color-neutral="black"]')!.click()
    hex.value = value!; hex.dispatchEvent(new Event('input', { bubbles: true }))
    expect(wheel.dataset.neutralMode ?? null).toBe(mode)
    expect(hex.value).toBe(value)
    if (mode === null) expect(panel.querySelector('[data-wheel-brightness]')!.getAttribute('aria-valuemax')).toBe('100')
  }
})

it('fits the popup to the visible viewport and stops tracking after disposal', () => {
  const viewport = Object.assign(new EventTarget(), { width: 312, height: 500, offsetLeft: 40, offsetTop: 20 })
  vi.stubGlobal('visualViewport', viewport)
  document.body.innerHTML = '<section><form><input id="hex" value="#123456"><div id="popup"><section data-color-picker-wheel></section></div></form></section>'
  const popup = document.getElementById('popup')!, controller = new AbortController()
  bindColorPickerPopup(popup, document.querySelector('input')!, controller.signal)
  popup.dispatchEvent(Object.assign(new Event('beforetoggle'), { newState: 'open' }))
  expect(popup.style.getPropertyValue('--picker-viewport-width')).toBe('312px')
  expect(popup.style.getPropertyValue('--picker-viewport-top')).toBe('20px')
  viewport.width = 280; viewport.offsetLeft = 60
  viewport.dispatchEvent(new Event('resize'))
  expect(popup.style.getPropertyValue('--picker-viewport-width')).toBe('280px')
  viewport.offsetLeft = 80; viewport.dispatchEvent(new Event('scroll'))
  expect(popup.style.getPropertyValue('--picker-viewport-left')).toBe('80px')
  controller.abort()
  viewport.width = 200; viewport.dispatchEvent(new Event('resize'))
  expect(popup.style.getPropertyValue('--picker-viewport-width')).toBe('280px')
})

it('keeps mobile selection compact and prevents wheel gestures from scrolling', () => {
  vi.stubGlobal('matchMedia', () => ({ matches: true }))
  document.body.innerHTML = '<form><input value="#123456"><section></section></form>'
  const panel = document.querySelector('section')!
  bindColorPickerWheel(panel, document.querySelector('input')!, undefined)
  expect(panel.querySelector('[data-wheel-hex]')!.getAttribute('aria-label')).toBe('Selected')
  const adjustments = panel.querySelector<HTMLDetailsElement>('.fm-picker-adjustments')!
  expect(adjustments.open).toBe(false)
  const body = panel.querySelector('.fm-picker-wheel-body')!
  expect([...body.children].map(child => child.className)).toEqual(['fm-header-color-wheel-wrap', 'fm-picker-complement-row', 'fm-picker-adjustments'])
  const touch = new Event('touchmove', { bubbles: true, cancelable: true })
  body.firstElementChild!.dispatchEvent(touch)
  expect(touch.defaultPrevented).toBe(true)
  panel.querySelector<HTMLButtonElement>('[data-color-neutral="white"]')!.click()
  expect(adjustments.querySelector('summary')!.textContent).toContain('80–100%')
})
