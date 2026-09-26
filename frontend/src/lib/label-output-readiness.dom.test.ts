// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest'

import { waitForLabelOutputAssets } from './label-output-readiness'

describe('label output crop readiness', () => {
  it('initializes a cropped image clone after its decoded dimensions become available', async () => {
    const source = document.createElement('div')
    source.innerHTML = `
      <div data-label-image-crop-viewport style="visibility: hidden">
        <img src="asset.png" data-label-image-crop-aspect-factor="0.5">
      </div>
    `
    const clone = source.cloneNode(true) as HTMLElement
    const image = clone.querySelector<HTMLImageElement>('img')!
    Object.defineProperty(image, 'decode', {
      configurable: true,
      value: async () => {
        Object.defineProperties(image, {
          naturalWidth: { configurable: true, value: 1200 },
          naturalHeight: { configurable: true, value: 600 },
        })
      },
    })

    await waitForLabelOutputAssets([clone])

    const viewport = clone.querySelector<HTMLElement>('[data-label-image-crop-viewport]')!
    expect(viewport.style.getPropertyValue('--label-image-crop-aspect')).toBe('1')
    expect(viewport.style.aspectRatio).toBe('1 / 1')
    expect(viewport.style.visibility).toBe('visible')
    expect(source.querySelector<HTMLElement>('[data-label-image-crop-viewport]')!.style.visibility)
      .toBe('hidden')
  })
})
