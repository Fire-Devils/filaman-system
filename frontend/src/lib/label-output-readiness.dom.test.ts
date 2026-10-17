// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest'

import { waitForLabelOutputAssets } from './label-output-readiness'

describe('label output image readiness', () => {
  it('waits for an image clone to decode before output', async () => {
    const source = document.createElement('div')
    source.innerHTML = '<img src="asset.png">'
    const clone = source.cloneNode(true) as HTMLElement
    const image = clone.querySelector<HTMLImageElement>('img')!
    let finishDecode!: () => void
    let settled = false
    Object.defineProperty(image, 'decode', {
      configurable: true,
      value: () => new Promise<void>(resolve => {
        finishDecode = () => {
          Object.defineProperties(image, {
            naturalWidth: { configurable: true, value: 1200 },
            naturalHeight: { configurable: true, value: 600 },
          })
          resolve()
        }
      }),
    })

    const readiness = waitForLabelOutputAssets([clone]).then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    finishDecode()
    await readiness
    expect(settled).toBe(true)
    expect(image.naturalWidth).toBe(1200)
  })

  it('waits for a load event when image.decode is unavailable', async () => {
    const root = document.createElement('div')
    root.innerHTML = '<img src="asset.png">'
    const image = root.querySelector<HTMLImageElement>('img')!
    Object.defineProperty(image, 'decode', { configurable: true, value: undefined })
    Object.defineProperty(image, 'complete', { configurable: true, value: false })
    let settled = false

    const readiness = waitForLabelOutputAssets([root]).then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)

    Object.defineProperties(image, {
      complete: { configurable: true, value: true },
      naturalWidth: { configurable: true, value: 1200 },
      naturalHeight: { configurable: true, value: 600 },
    })
    image.dispatchEvent(new Event('load'))
    await readiness

    expect(settled).toBe(true)
  })

  it('rejects a load error when image.decode is unavailable', async () => {
    const image = document.createElement('img')
    image.src = 'missing.png'
    Object.defineProperty(image, 'decode', { configurable: true, value: undefined })
    Object.defineProperty(image, 'complete', { configurable: true, value: false })

    const readiness = waitForLabelOutputAssets([image])
    image.dispatchEvent(new Event('error'))

    await expect(readiness).rejects.toThrow('could not load')
  })
})
