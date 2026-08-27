// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const imageMock = vi.hoisted(() => ({
  toCanvas: vi.fn(),
}))

const pdfMock = vi.hoisted(() => {
  const addPage = vi.fn()
  const addImage = vi.fn()
  const save = vi.fn()
  const output = vi.fn()
  const document = { addPage, addImage, save, output }
  const jsPDF = vi.fn(() => document)
  return { addPage, addImage, save, output, document, jsPDF }
})

vi.mock('jspdf', () => ({ jsPDF: pdfMock.jsPDF }))
vi.mock('html-to-image', () => ({ toCanvas: imageMock.toCanvas }))

import {
  captureLabelElement,
  createLabelPagesPdf,
  type LabelPdfPage,
} from './label-export'

const pages: LabelPdfPage[] = [
  {
    dataUrl: 'data:image/png;base64,first',
    widthMm: 60,
    heightMm: 40,
  },
  {
    dataUrl: 'data:image/png;base64,second',
    widthMm: 40,
    heightMm: 60,
  },
]

function makeCaptureCanvas(dataUrl: string, content: 'blank' | 'noise' | 'visible') {
  const width = 40
  const height = 40
  const pixels = new Uint8ClampedArray(width * height * 4)
  for (let index = 0; index < pixels.length; index += 4) {
    pixels[index] = 254
    pixels[index + 1] = 254
    pixels[index + 2] = 254
    pixels[index + 3] = 255
  }
  const darkPixels = content === 'visible' ? 32 : content === 'noise' ? 1 : 0
  for (let pixel = 0; pixel < darkPixels; pixel += 1) {
    const index = pixel * 4
    pixels[index] = 0
    pixels[index + 1] = 0
    pixels[index + 2] = 0
  }
  return {
    width,
    height,
    getContext: vi.fn(() => ({
      getImageData: vi.fn(() => ({ data: pixels })),
    })),
    toDataURL: vi.fn(() => dataUrl),
  } as unknown as HTMLCanvasElement
}

beforeEach(() => {
  vi.clearAllMocks()
  pdfMock.output.mockReturnValue(
    new Blob(['pdf'], { type: 'application/pdf' }),
  )
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('label capture scheduling', () => {
  it('retries an apparently successful blank raster before returning the capture', async () => {
    const label = document.createElement('div')
    label.textContent = 'Visible label'
    document.body.appendChild(label)
    const captureSources: HTMLElement[] = []
    imageMock.toCanvas
      .mockImplementationOnce(async element => {
        captureSources.push(element)
        return makeCaptureCanvas('data:image/png;base64,noise', 'noise')
      })
      .mockImplementationOnce(async element => {
        expect(captureSources[0].isConnected).toBe(false)
        captureSources.push(element)
        return makeCaptureCanvas('data:image/png;base64,visible', 'visible')
      })

    await expect(captureLabelElement(label)).resolves.toBe(
      'data:image/png;base64,visible',
    )
    expect(imageMock.toCanvas).toHaveBeenCalledTimes(2)
    expect(captureSources[1]).not.toBe(captureSources[0])
    expect(captureSources.every(source => !source.isConnected)).toBe(true)
  })

  it('rejects instead of exporting when both raster attempts are blank', async () => {
    const label = document.createElement('div')
    label.textContent = 'Visible label'
    document.body.appendChild(label)
    imageMock.toCanvas.mockResolvedValue(
      makeCaptureCanvas('data:image/png;base64,blank', 'blank'),
    )

    await expect(captureLabelElement(label)).rejects.toThrow(
      'renderer returned a blank image twice',
    )
    expect(imageMock.toCanvas).toHaveBeenCalledTimes(2)
    expect(document.querySelectorAll('[aria-hidden="true"]')).toHaveLength(0)
  })

  it('captures an off-screen clone without mutating the visible preview', async () => {
    const label = document.createElement('div')
    label.id = 'label-preview'
    label.className = 'label-preview'
    label.style.transform = 'scale(1.25)'
    label.style.transformOrigin = 'center center'
    label.style.borderColor = 'red'
    label.style.borderRadius = '12px'
    label.style.boxShadow = '0 4px 12px black'
    const child = document.createElement('span')
    child.id = 'label-child'
    child.textContent = 'Visible label'
    label.appendChild(child)
    document.body.appendChild(label)

    let captureSource: HTMLElement | undefined
    imageMock.toCanvas.mockImplementation(async element => {
      captureSource = element
      expect(element).not.toBe(label)
      expect(element.isConnected).toBe(true)
      expect(element.id).toBe('')
      expect(element.querySelector('[id]')).toBeNull()
      expect(element.style.position).toBe('')
      expect(element.style.left).toBe('')
      expect(element.parentElement?.style.position).toBe('fixed')
      expect(element.parentElement?.style.left).toBe('-100000px')
      expect(element.style.transform).toBe('none')
      expect(element.style.boxShadow).toBe('none')
      expect(label.style.transform).toBe('scale(1.25)')
      expect(label.style.boxShadow).toBe('0 4px 12px black')
      return makeCaptureCanvas('data:image/png;base64,label', 'visible')
    })

    await expect(captureLabelElement(label, {
      resetTransform: true,
    })).resolves.toBe('data:image/png;base64,label')

    expect(captureSource?.isConnected).toBe(false)
    expect(label.style.transform).toBe('scale(1.25)')
    expect(label.style.transformOrigin).toBe('center center')
    expect(label.style.borderColor).toBe('red')
    expect(label.style.borderRadius).toBe('12px')
    expect(label.style.boxShadow).toBe('0 4px 12px black')
  })

  it('completes when the PNG renderer needs a visual frame after Print backgrounds the source tab', async () => {
    vi.useFakeTimers()
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 0)
    vi.stubGlobal('requestAnimationFrame', () => 0)
    imageMock.toCanvas.mockImplementation(() => new Promise(resolve => {
      globalThis.requestAnimationFrame(() => {
        resolve(makeCaptureCanvas('data:image/png;base64,label', 'visible'))
      })
    }))
    const label = document.createElement('div')
    document.body.appendChild(label)
    let captured: string | undefined

    void captureLabelElement(label).then(dataUrl => {
      captured = dataUrl
    })

    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(250)
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(1)
    await Promise.resolve()

    expect(captured).toBe('data:image/png;base64,label')
  })
})

describe('individual label PDF construction', () => {
  it('builds exact millimeter pages without choosing an output destination', async () => {
    const pdf = await createLabelPagesPdf(pages)

    expect(pdf).toBe(pdfMock.document)
    expect(pdfMock.jsPDF).toHaveBeenCalledWith({
      orientation: 'l',
      unit: 'mm',
      format: [60, 40],
    })
    expect(pdfMock.addPage).toHaveBeenCalledWith([40, 60], 'p')
    expect(pdfMock.addImage).toHaveBeenNthCalledWith(
      1,
      pages[0].dataUrl,
      'PNG',
      0,
      0,
      60,
      40,
      'label-page-0',
      'FAST',
    )
    expect(pdfMock.addImage).toHaveBeenNthCalledWith(
      2,
      pages[1].dataUrl,
      'PNG',
      0,
      0,
      40,
      60,
      'label-page-1',
      'FAST',
    )
    expect(pdfMock.save).not.toHaveBeenCalled()
    expect(pdfMock.output).not.toHaveBeenCalled()
  })

  it('returns null and does not construct jsPDF for an empty page list', async () => {
    await expect(createLabelPagesPdf([])).resolves.toBeNull()
    expect(pdfMock.jsPDF).not.toHaveBeenCalled()
  })
})
