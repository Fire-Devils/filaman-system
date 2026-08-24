import { beforeEach, describe, expect, it, vi } from 'vitest'

const pdfMock = vi.hoisted(() => {
  const addPage = vi.fn()
  const addImage = vi.fn()
  const save = vi.fn()
  const output = vi.fn()
  const setPage = vi.fn()
  const setDrawColor = vi.fn()
  const setLineWidth = vi.fn()
  const rect = vi.fn()
  const clip = vi.fn()
  const saveGraphicsState = vi.fn()
  const restoreGraphicsState = vi.fn()
  const document = {
    addPage,
    addImage,
    save,
    output,
    setPage,
    setDrawColor,
    setLineWidth,
    rect,
    clip,
    saveGraphicsState,
    restoreGraphicsState,
  }
  const jsPDF = vi.fn(() => document)
  return {
    addPage,
    addImage,
    save,
    output,
    setPage,
    setDrawColor,
    setLineWidth,
    rect,
    clip,
    saveGraphicsState,
    restoreGraphicsState,
    document,
    jsPDF,
  }
})

vi.mock('jspdf', () => ({ jsPDF: pdfMock.jsPDF }))

import {
  createLabelSheetPdf,
  type LabelSheetSettings,
} from './label-sheet'
import type { LabelPdfPage } from './label-export'

const settings: LabelSheetSettings = {
  paperSize: 'custom',
  customWidthMm: 100,
  customHeightMm: 50,
  rows: 1,
  columns: 2,
  marginTopMm: 5,
  marginRightMm: 5,
  marginBottomMm: 5,
  marginLeftMm: 5,
  gapHorizontalMm: 2,
  gapVerticalMm: 0,
  skipCells: 0,
  copies: 1,
  showGrid: false,
  printGrid: false,
  fitToCell: true,
}

const labels: LabelPdfPage[] = [
  {
    dataUrl: 'data:image/png;base64,first',
    widthMm: 60,
    heightMm: 40,
  },
  {
    dataUrl: 'data:image/png;base64,second',
    widthMm: 60,
    heightMm: 40,
  },
]

beforeEach(() => {
  vi.clearAllMocks()
})

describe('label-sheet PDF construction', () => {
  it('returns a PDF document without saving it', async () => {
    const pdf = await createLabelSheetPdf(labels, settings)

    expect(pdf).toBe(pdfMock.document)
    expect(pdfMock.jsPDF).toHaveBeenCalledWith({
      orientation: 'l',
      unit: 'mm',
      format: [100, 50],
    })
    expect(pdfMock.save).not.toHaveBeenCalled()
    expect(pdfMock.output).not.toHaveBeenCalled()
    expect(pdfMock.addImage).toHaveBeenCalledTimes(2)
  })

  it('uses existing fit-to-cell placement in millimeters', async () => {
    await createLabelSheetPdf(labels, settings)

    const first = pdfMock.addImage.mock.calls[0]
    const second = pdfMock.addImage.mock.calls[1]

    expect(first[0]).toBe(labels[0].dataUrl)
    expect(first[1]).toBe('PNG')
    expect(first[2]).toBeCloseTo(5, 6)
    expect(first[3]).toBeCloseTo(10.333333, 5)
    expect(first[4]).toBeCloseTo(44, 6)
    expect(first[5]).toBeCloseTo(29.333333, 5)

    expect(second[2]).toBeCloseTo(51, 6)
    expect(second[3]).toBeCloseTo(10.333333, 5)
    expect(second[4]).toBeCloseTo(44, 6)
    expect(second[5]).toBeCloseTo(29.333333, 5)
  })

  it('returns null for an empty label list', async () => {
    await expect(createLabelSheetPdf([], settings)).resolves.toBeNull()
    expect(pdfMock.jsPDF).not.toHaveBeenCalled()
  })
})
