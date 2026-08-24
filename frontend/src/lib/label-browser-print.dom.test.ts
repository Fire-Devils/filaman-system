// @vitest-environment happy-dom

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'

import {
  cleanupLabelBrowserPrint,
  createLabelBrowserPrintJob,
  printLabelBrowserJob,
} from './label-browser-print'
import type { LabelSheetSettings } from './label-sheet'

const sheetSettings: LabelSheetSettings = {
  paperSize: 'custom',
  customWidthMm: 100,
  customHeightMm: 150,
  rows: 2,
  columns: 2,
  marginTopMm: 5,
  marginRightMm: 5,
  marginBottomMm: 5,
  marginLeftMm: 5,
  gapHorizontalMm: 2,
  gapVerticalMm: 2,
  skipCells: 0,
  copies: 1,
  showGrid: false,
  printGrid: true,
  fitToCell: true,
}

const originalFontsDescriptor = Object.getOwnPropertyDescriptor(
  document,
  'fonts',
)

function setFontsReady(ready: Promise<unknown>) {
  Object.defineProperty(document, 'fonts', {
    configurable: true,
    value: { ready },
  })
}

function makeIndividualPage(id = 'wrapper-1') {
  const wrapper = document.createElement('div')
  wrapper.id = id
  wrapper.className = 'label-wrapper'
  wrapper.style.transform = 'scale(1.5)'
  wrapper.style.width = '720px'
  wrapper.style.height = '450px'
  wrapper.innerHTML = `
    <div class="label-preview" id="${id}-label"
      style="transform: scale(1.5); transform-origin: top left; box-shadow: 0 4px 8px black; border: 1px dashed gray">
      <div class="designer-element" id="${id}-designer"
        style="position:absolute; transform:rotate(12deg)">Text</div>
    </div>
  `
  return wrapper
}

beforeEach(() => {
  document.body.innerHTML = ''
  setFontsReady(Promise.resolve())
  Object.defineProperty(window, 'print', {
    configurable: true,
    value: () => undefined,
  })
})

afterEach(() => {
  cleanupLabelBrowserPrint()
  vi.useRealTimers()
  vi.restoreAllMocks()
  if (originalFontsDescriptor) {
    Object.defineProperty(document, 'fonts', originalFontsDescriptor)
  } else {
    Reflect.deleteProperty(document, 'fonts')
  }
})

describe('createLabelBrowserPrintJob', () => {
  it('uses supplied individual wrappers and label dimensions', () => {
    const previewRoot = document.createElement('div')
    const wrapperOne = makeIndividualPage('wrapper-1')
    const wrapperTwo = makeIndividualPage('wrapper-2')

    const job = createLabelBrowserPrintJob({
      outputMode: 'individual',
      previewRoot,
      individualPages: [wrapperOne, wrapperTwo],
      individualDimensions: { widthMm: 48, heightMm: 30 },
      sheetSettings,
    })

    expect(job).toMatchObject({
      kind: 'individual',
      widthMm: 48,
      heightMm: 30,
      pages: [wrapperOne, wrapperTwo],
      printGrid: false,
    })
  })

  it('queries rendered sheet pages and uses the sheet layout dimensions', () => {
    const previewRoot = document.createElement('div')
    previewRoot.innerHTML = `
      <div class="label-sheet-page-frame">
        <section class="label-sheet-page" id="sheet-1"></section>
      </div>
      <section class="label-sheet-page" id="sheet-2"></section>
    `
    const pages = Array.from(
      previewRoot.querySelectorAll<HTMLElement>('.label-sheet-page'),
    )

    const job = createLabelBrowserPrintJob({
      outputMode: 'sheet',
      previewRoot,
      individualPages: [makeIndividualPage()],
      individualDimensions: { widthMm: 48, heightMm: 30 },
      sheetSettings,
    })

    expect(job).toMatchObject({
      kind: 'sheet',
      widthMm: 100,
      heightMm: 150,
      pages,
      printGrid: true,
    })
  })

  it('rejects unsupported modes, invalid dimensions, and empty jobs', () => {
    const source = {
      outputMode: 'individual' as const,
      previewRoot: document.createElement('div'),
      individualPages: [makeIndividualPage()],
      individualDimensions: { widthMm: 48, heightMm: 30 },
      sheetSettings,
    }

    expect(() => createLabelBrowserPrintJob({
      ...source,
      outputMode: 'unsupported' as 'individual',
    })).toThrow(/output mode/i)
    expect(() => createLabelBrowserPrintJob({
      ...source,
      individualDimensions: { widthMm: 0, heightMm: 30 },
    })).toThrow(/dimensions/i)
    expect(() => createLabelBrowserPrintJob({
      ...source,
      individualPages: [],
    })).toThrow(/page/i)
  })
})

describe('printLabelBrowserJob', () => {
  it('waits for images, prints sanitized clones, and cleans up afterprint', async () => {
    const source = makeIndividualPage()
    const image = document.createElement('img')
    image.id = 'logo'
    image.src = 'logo.png'
    source.querySelector('.label-preview')!.appendChild(image)
    document.body.appendChild(source)
    let resolveDecode!: () => void
    Object.defineProperty(image, 'decode', {
      configurable: true,
      value: vi.fn(() => new Promise<void>(resolve => {
        resolveDecode = resolve
      })),
    })
    const print = vi.spyOn(window, 'print')
      .mockImplementation(() => undefined)

    const promise = printLabelBrowserJob({
      kind: 'individual',
      widthMm: 48,
      heightMm: 30,
      pages: [source],
      printGrid: false,
    })
    await Promise.resolve()

    expect(print).not.toHaveBeenCalled()
    expect(document.body.classList.contains('filaman-label-printing')).toBe(true)
    resolveDecode()
    await promise

    expect(print).toHaveBeenCalledOnce()
    const host = document.querySelector<HTMLElement>(
      '#filaman-label-print-host',
    )!
    const clone = host.querySelector<HTMLElement>('.label-wrapper')!
    const clonedPreview = clone.querySelector<HTMLElement>('.label-preview')!
    const clonedDesigner = clone.querySelector<HTMLElement>(
      '.designer-element',
    )!
    expect(host.contains(source)).toBe(false)
    expect(host.querySelector('[id]')).toBeNull()
    expect(clone.style.transform).toBe('none')
    expect(clone.style.width).toBe('')
    expect(clone.style.height).toBe('')
    expect(clonedPreview.style.transform).toBe('none')
    expect(clonedPreview.style.boxShadow).toBe('none')
    expect(clonedPreview.style.borderStyle).toBe('none')
    expect(clonedDesigner.style.position).toBe('absolute')
    expect(clonedDesigner.style.transform).toBe('rotate(12deg)')

    const styleText = document.querySelector<HTMLStyleElement>(
      '#filaman-label-print-style',
    )!.textContent!
    expect(styleText).toContain('@page { size: 48mm 30mm; margin: 0; }')
    expect(styleText).not.toMatch(/\b(?:portrait|landscape)\b/)
    expect(styleText.match(/break-after:\s*page/g)).toHaveLength(1)
    expect(styleText).toMatch(
      /\.filaman-print-page:last-child\s*{[^}]*break-after:\s*auto/s,
    )
    expect(styleText).toMatch(
      /body\s*>\s*:not\(#filaman-label-print-host\)/,
    )
    expect(styleText).toMatch(
      /#filaman-label-print-host\s*\{[^}]*display:\s*none\s*!important/s,
    )
    expect(styleText).toContain('-webkit-print-color-adjust: exact !important')
    expect(styleText).toContain('print-color-adjust: exact !important')
    expect(styleText).toMatch(
      /\.label-sheet-label-shell::after\s*\{[^}]*display:\s*none\s*!important/s,
    )

    window.dispatchEvent(new Event('afterprint'))
    expect(document.querySelector('#filaman-label-print-host')).toBeNull()
    expect(document.querySelector('#filaman-label-print-style')).toBeNull()
    expect(document.body.classList.contains('filaman-label-printing'))
      .toBe(false)
  })

  it('waits for document fonts before printing', async () => {
    let resolveFonts!: () => void
    setFontsReady(new Promise<void>(resolve => {
      resolveFonts = resolve
    }))
    const print = vi.spyOn(window, 'print')
      .mockImplementation(() => undefined)

    const promise = printLabelBrowserJob({
      kind: 'individual',
      widthMm: 48,
      heightMm: 30,
      pages: [makeIndividualPage()],
      printGrid: false,
    })
    await Promise.resolve()

    expect(print).not.toHaveBeenCalled()
    resolveFonts()
    await promise
    expect(print).toHaveBeenCalledOnce()
  })

  it('resets sheet preview positioning and applies the requested grid state', async () => {
    const source = document.createElement('section')
    source.className = 'label-sheet-page'
    source.style.position = 'absolute'
    source.style.left = '0px'
    source.style.top = '0px'
    source.style.transform = 'scale(1.5)'
    source.style.transformOrigin = 'top left'
    source.style.outline = '1px dashed gray'
    source.innerHTML = `
      <div class="label-sheet-grid">
        <div class="label-sheet-cell label-sheet-cell-grid"></div>
      </div>
    `
    vi.spyOn(window, 'print').mockImplementation(() => undefined)

    await printLabelBrowserJob({
      kind: 'sheet',
      widthMm: 100,
      heightMm: 150,
      pages: [source],
      printGrid: true,
    })

    const printPage = document.querySelector<HTMLElement>(
      '.filaman-print-page',
    )!
    const clonedSheet = printPage.querySelector<HTMLElement>(
      '.label-sheet-page',
    )!
    expect(printPage.classList.contains('filaman-print-grid')).toBe(true)
    expect(clonedSheet.style.position).toBe('static')
    expect(clonedSheet.style.left).toBe('auto')
    expect(clonedSheet.style.top).toBe('auto')
    expect(clonedSheet.style.transform).toBe('none')
    expect(clonedSheet.style.outlineStyle).toBe('none')

    const styleText = document.querySelector<HTMLStyleElement>(
      '#filaman-label-print-style',
    )!.textContent!
    expect(styleText).toMatch(
      /\.label-sheet-label-shell::after\s*\{[^}]*display:\s*none\s*!important/s,
    )

    cleanupLabelBrowserPrint()
    await printLabelBrowserJob({
      kind: 'sheet',
      widthMm: 100,
      heightMm: 150,
      pages: [source],
      printGrid: false,
    })
    const withoutGrid = document.querySelector<HTMLElement>(
      '.filaman-print-page',
    )!
    expect(withoutGrid.classList.contains('filaman-print-grid')).toBe(false)
    expect(withoutGrid.querySelector('.label-sheet-print-grid')).toBeNull()
  })

  it('cleans up and rejects when an incomplete image fails to decode', async () => {
    const source = makeIndividualPage()
    const image = document.createElement('img')
    source.appendChild(image)
    Object.defineProperty(image, 'complete', {
      configurable: true,
      value: false,
    })
    Object.defineProperty(image, 'decode', {
      configurable: true,
      value: vi.fn(async () => {
        throw new Error('decode failed')
      }),
    })
    const print = vi.spyOn(window, 'print')
      .mockImplementation(() => undefined)

    await expect(printLabelBrowserJob({
      kind: 'individual',
      widthMm: 48,
      heightMm: 30,
      pages: [source],
      printGrid: false,
    })).rejects.toThrow('decode failed')
    expect(print).not.toHaveBeenCalled()
    expect(document.querySelector('#filaman-label-print-host')).toBeNull()
    expect(document.querySelector('#filaman-label-print-style')).toBeNull()
    expect(document.body.classList.contains('filaman-label-printing'))
      .toBe(false)
  })

  it('ignores decode rejection for an image that is already complete', async () => {
    const source = makeIndividualPage()
    const image = document.createElement('img')
    source.appendChild(image)
    Object.defineProperty(image, 'complete', {
      configurable: true,
      value: true,
    })
    Object.defineProperty(image, 'decode', {
      configurable: true,
      value: vi.fn(async () => {
        throw new Error('already loaded')
      }),
    })
    const print = vi.spyOn(window, 'print')
      .mockImplementation(() => undefined)

    await printLabelBrowserJob({
      kind: 'individual',
      widthMm: 48,
      heightMm: 30,
      pages: [source],
      printGrid: false,
    })

    expect(print).toHaveBeenCalledOnce()
  })

  it('cleans up when window.print throws', async () => {
    vi.spyOn(window, 'print').mockImplementation(() => {
      throw new Error('print failed')
    })

    await expect(printLabelBrowserJob({
      kind: 'individual',
      widthMm: 48,
      heightMm: 30,
      pages: [makeIndividualPage()],
      printGrid: false,
    })).rejects.toThrow('print failed')
    expect(document.querySelector('#filaman-label-print-host')).toBeNull()
    expect(document.querySelector('#filaman-label-print-style')).toBeNull()
    expect(document.body.classList.contains('filaman-label-printing'))
      .toBe(false)
  })

  it('cleans up on pagehide and with the fallback timer', async () => {
    vi.useFakeTimers()
    vi.spyOn(window, 'requestAnimationFrame')
      .mockImplementation(callback => {
        callback(0)
        return 1
      })
    vi.spyOn(window, 'cancelAnimationFrame')
      .mockImplementation(() => undefined)
    vi.spyOn(window, 'print').mockImplementation(() => undefined)
    const job = {
      kind: 'individual' as const,
      widthMm: 48,
      heightMm: 30,
      pages: [makeIndividualPage()],
      printGrid: false,
    }

    await printLabelBrowserJob(job)
    window.dispatchEvent(new Event('pagehide'))
    expect(document.querySelector('#filaman-label-print-host')).toBeNull()

    await printLabelBrowserJob(job)
    expect(document.querySelector('#filaman-label-print-host')).not.toBeNull()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(document.querySelector('#filaman-label-print-host')).toBeNull()
    expect(document.querySelector('#filaman-label-print-style')).toBeNull()
  })

  it('rejects malformed jobs without creating print state', async () => {
    await expect(printLabelBrowserJob({
      kind: 'individual',
      widthMm: Number.NaN,
      heightMm: 30,
      pages: [makeIndividualPage()],
      printGrid: false,
    })).rejects.toThrow(/dimensions/i)
    await expect(printLabelBrowserJob({
      kind: 'individual',
      widthMm: 48,
      heightMm: 30,
      pages: [],
      printGrid: false,
    })).rejects.toThrow(/page/i)
    expect(document.querySelector('#filaman-label-print-host')).toBeNull()
    expect(document.querySelector('#filaman-label-print-style')).toBeNull()
  })
})
