// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'

import { copyText } from './clipboard'

afterEach(() => {
  vi.restoreAllMocks()
  Reflect.deleteProperty(navigator, 'clipboard')
  Reflect.deleteProperty(document, 'execCommand')
  document.body.innerHTML = ''
})

describe('copyText', () => {
  it('copies through the DOM fallback when the Clipboard API is unavailable', async () => {
    let copiedText = ''
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: undefined,
    })
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: vi.fn(() => {
        copiedText = document.querySelector('textarea')?.value ?? ''
        return true
      }),
    })

    await expect(copyText('ABC123')).resolves.toBe(true)

    expect(copiedText).toBe('ABC123')
    expect(document.querySelector('textarea')).toBeNull()
  })

  it('returns false when no clipboard method is available', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: undefined,
    })
    Reflect.deleteProperty(document, 'execCommand')

    await expect(copyText('ABC123')).resolves.toBe(false)

    expect(document.querySelector('textarea')).toBeNull()
  })
})
