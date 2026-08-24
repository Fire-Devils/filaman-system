// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const imageMock = vi.hoisted(() => ({
  toPng: vi.fn(),
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
vi.mock('html-to-image', () => ({ toPng: imageMock.toPng }))

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
  it('completes when the PNG renderer needs a visual frame after Print backgrounds the source tab', async () => {
    vi.useFakeTimers()
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 0)
    vi.stubGlobal('requestAnimationFrame', () => 0)
    imageMock.toPng.mockImplementation(() => new Promise(resolve => {
      globalThis.requestAnimationFrame(() => {
        resolve('data:image/png;base64,label')
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
