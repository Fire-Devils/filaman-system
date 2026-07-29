// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest'

import {
  alphaPercentToHex,
  bindAlphaColorControls,
  composeHexWithAlpha,
  composeHexWithAlphaByte,
  getAlphaPercent,
  normalizeHexCode,
  toColorSwatchBackground,
  toCssColor,
  toOpaqueRgbHex,
} from './colors'

function createAlphaControls() {
  const picker = document.createElement('input')
  picker.type = 'color'
  const hexInput = document.createElement('input')
  const alphaEnabled = document.createElement('input')
  alphaEnabled.type = 'checkbox'
  const alphaOptions = document.createElement('div')
  alphaOptions.classList.add('hidden')
  const alphaPreview = document.createElement('span')
  const alphaInput = document.createElement('input')
  alphaInput.type = 'range'
  alphaInput.min = '0'
  alphaInput.max = '100'
  const alphaValueInput = document.createElement('input')
  alphaValueInput.type = 'number'
  const alphaHexInput = document.createElement('input')
  alphaHexInput.type = 'text'

  const controls = bindAlphaColorControls({
    picker,
    hexInput,
    alphaEnabled,
    alphaOptions,
    alphaPreview,
    alphaInput,
    alphaValueInput,
    alphaHexInput,
  })

  return {
    controls,
    picker,
    hexInput,
    alphaEnabled,
    alphaOptions,
    alphaPreview,
    alphaInput,
    alphaValueInput,
    alphaHexInput,
  }
}

describe('color helpers', () => {
  it('normalizes supported RGB and RGBA forms', () => {
    expect(normalizeHexCode('abc')).toBe('#AABBCC')
    expect(normalizeHexCode('#abcd')).toBe('#AABBCCDD')
    expect(normalizeHexCode('00d4d488')).toBe('#00D4D488')
  })

  it('rejects malformed values instead of returning unsafe CSS fallbacks', () => {
    expect(normalizeHexCode('#12345')).toBe('')
    expect(normalizeHexCode('not-a-color')).toBe('')
    expect(toCssColor('not-a-color')).toBe('transparent')
  })

  it('converts alpha colors for CSS and opaque consumers', () => {
    expect(toOpaqueRgbHex('#BE000022')).toBe('#BE0000')
    expect(toCssColor('#BE000080')).toBe('rgba(190, 0, 0, 0.502)')
    expect(toColorSwatchBackground('#BE000080')).toContain(
      'linear-gradient(rgba(190, 0, 0, 0.502), rgba(190, 0, 0, 0.502))'
    )
    expect(toColorSwatchBackground('#BE000080')).toContain('conic-gradient(')
  })

  it('round-trips opacity controls through trailing alpha bytes', () => {
    expect(composeHexWithAlpha('#00D4D4', 50)).toBe('#00D4D480')
    expect(getAlphaPercent('#00D4D480')).toBe(50)
    expect(composeHexWithAlpha('#00D4D480', 100)).toBe('#00D4D4')
    expect(composeHexWithAlpha('#00D4D4', 100, true)).toBe('#00D4D4FF')
    expect(alphaPercentToHex(25)).toBe('40')
    expect(composeHexWithAlphaByte('#00D4D4', '3c')).toBe('#00D4D43C')
  })

  it('keeps normal colors six-digit until opacity is explicitly enabled', () => {
    const {
      controls,
      hexInput,
      alphaEnabled,
      alphaOptions,
      alphaInput,
      alphaValueInput,
      alphaHexInput,
    } = createAlphaControls()

    controls.reset('#336699')
    expect(alphaEnabled.checked).toBe(false)
    expect(alphaOptions.classList.contains('hidden')).toBe(true)
    expect(hexInput.value).toBe('#336699')
    expect(alphaHexInput.value).toBe('FF')

    alphaEnabled.checked = true
    alphaEnabled.dispatchEvent(new Event('change'))
    expect(alphaOptions.classList.contains('hidden')).toBe(false)
    expect(hexInput.value).toBe('#336699FF')

    alphaInput.value = '25'
    alphaInput.dispatchEvent(new Event('input'))
    expect(alphaValueInput.value).toBe('25')
    expect(alphaHexInput.value).toBe('40')
    expect(hexInput.value).toBe('#33669940')

    alphaValueInput.value = '50'
    alphaValueInput.dispatchEvent(new Event('input'))
    expect(alphaInput.value).toBe('50')
    expect(alphaHexInput.value).toBe('80')
    expect(hexInput.value).toBe('#33669980')

    alphaHexInput.value = '3c'
    alphaHexInput.dispatchEvent(new Event('input'))
    expect(alphaInput.value).toBe('24')
    expect(alphaValueInput.value).toBe('24')
    expect(alphaHexInput.value).toBe('3C')
    expect(hexInput.value).toBe('#3366993C')

    alphaValueInput.value = ''
    alphaValueInput.dispatchEvent(new Event('change'))
    expect(alphaValueInput.value).toBe('24')
    expect(hexInput.value).toBe('#3366993C')

    alphaHexInput.value = 'G'
    alphaHexInput.dispatchEvent(new Event('change'))
    expect(alphaHexInput.value).toBe('3C')
    expect(hexInput.value).toBe('#3366993C')

    alphaEnabled.checked = false
    alphaEnabled.dispatchEvent(new Event('change'))
    expect(hexInput.value).toBe('#336699')
  })

  it('derives the opacity checkbox from a manually entered AA suffix', () => {
    const {
      controls,
      alphaEnabled,
      alphaOptions,
      alphaInput,
      alphaValueInput,
      alphaHexInput,
    } = createAlphaControls()

    controls.reset('#D8100C3C')
    expect(alphaEnabled.checked).toBe(true)
    expect(alphaOptions.classList.contains('hidden')).toBe(false)
    expect(alphaInput.value).toBe('24')
    expect(alphaValueInput.value).toBe('24')
    expect(alphaHexInput.value).toBe('3C')

    controls.reset('#D8100C')
    expect(alphaEnabled.checked).toBe(false)
    expect(alphaOptions.classList.contains('hidden')).toBe(true)
  })
})
