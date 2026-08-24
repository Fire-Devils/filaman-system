// @vitest-environment happy-dom

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import JSZip from 'jszip'

import {
  LABEL_PRINT_PDF_MODE_KEY,
  bindBatchLabelExport,
  bindPdfOutputActions,
  bindPrintPdfPreference,
  bindSingleLabelExport,
  releasePrintPdfUrls,
} from './label-print-page'
import type { LabelPdfDocument } from './label-export'
import {
  syncLabelSheetIndividualExportState,
  type LabelSheetControls,
} from './label-sheet'
import {
  cleanupLabelBrowserPrint,
  printLabelBrowserJob,
} from './label-browser-print'

vi.mock('./label-export', async importOriginal => {
  const actual = await importOriginal<typeof import('./label-export')>()
  return {
    ...actual,
    createLabelPagesPdf: vi.fn(async () => null),
  }
})

vi.mock('./label-browser-print', () => ({
  cleanupLabelBrowserPrint: vi.fn(),
  createLabelBrowserPrintJob: vi.fn(source => ({
    kind: source.outputMode,
    widthMm: source.individualDimensions.widthMm,
    heightMm: source.individualDimensions.heightMm,
    pages: source.individualPages,
    printGrid: false,
  })),
  printLabelBrowserJob: vi.fn(async () => window.print()),
}))

function makePdfDocument() {
  return {
    save: vi.fn(),
    output: vi.fn(
      () => new Blob(['pdf'], { type: 'application/pdf' }),
    ),
  } satisfies LabelPdfDocument
}

function makePopup() {
  const popupDocument = document.implementation.createHTMLDocument('')
  const replace = vi.fn()
  const close = vi.fn()
  return {
    popup: {
      document: popupDocument,
      location: { replace },
      close,
    } as unknown as Window,
    replace,
    close,
  }
}

function makeBrowserPrintBinding(
  page = document.querySelector<HTMLElement>('#label') ?? document.body,
) {
  const sheetControls = {
    getOutputMode: () => 'individual',
    getSettings: () => (
      {} as ReturnType<LabelSheetControls['getSettings']>
    ),
    setOutputMode: () => undefined,
  } as LabelSheetControls
  return {
    previewRoot: document.body,
    sheetControls,
    getIndividualPages: () => [page],
  }
}

function bindDeferredCapture(
  kind: 'single-label' | 'batch',
  captureLabel: () => Promise<string>,
) {
  const printButton = document.querySelector<HTMLButtonElement>('#print')!
  const pngButton = document.querySelector<HTMLButtonElement>('#png')!
  const amlButton = document.querySelector<HTMLButtonElement>('#aml')!
  const pdfButton = document.querySelector<HTMLButtonElement>('#pdf')!
  const printPdfCheckbox =
    document.querySelector<HTMLInputElement>('#pdf-mode')!
  const labelElement = document.querySelector<HTMLElement>('#label')!

  if (kind === 'single-label') {
    bindSingleLabelExport({
      printButton,
      printPdfCheckbox,
      exportPngBtn: pngButton,
      exportAmlBtn: amlButton,
      exportPdfBtn: pdfButton,
      labelElement,
      getTranslation: (_key, fallback) => fallback,
      buildBaseName: () => 'single-label',
      getDimensions: () => ({ widthMm: 60, heightMm: 40 }),
      refreshPreview: vi.fn(async () => undefined),
      captureLabel,
      browserPrint: makeBrowserPrintBinding(labelElement),
    })
  } else {
    bindBatchLabelExport({
      entities: () => [{ id: 1 }],
      activeTab: () => 'print',
      printButton,
      printPdfCheckbox,
      pngButton,
      amlButton,
      pdfButton,
      getTranslation: (_key, fallback) => fallback,
      renderAll: vi.fn(async () => undefined),
      captureLabel,
      getPdfDimensions: () => ({ widthMm: 60, heightMm: 40 }),
      singlePngName: entity => `label-${entity.id}.png`,
      zipName: () => 'labels.zip',
      zipEntryName: entity => `label-${entity.id}.png`,
      pdfName: () => 'batch-labels.pdf',
      browserPrint: makeBrowserPrintBinding(labelElement),
    })
  }

  return {
    printButton,
    printPdfCheckbox,
    pngButton,
    amlButton,
    pdfButton,
  }
}

beforeEach(() => {
  vi.mocked(printLabelBrowserJob)
    .mockImplementation(async () => window.print())
  vi.mocked(cleanupLabelBrowserPrint).mockClear()
  localStorage.clear()
  document.body.innerHTML = `
    <button id="print">Print</button>
    <button id="pdf">Export PDF</button>
    <input id="pdf-mode" type="checkbox">
    <div id="label"></div>
  `
  Object.defineProperty(window, 'print', {
    configurable: true,
    value: () => undefined,
  })
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: vi.fn(() => 'blob:filaman-print-pdf'),
  })
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    value: vi.fn(),
  })
})

afterEach(() => {
  releasePrintPdfUrls()
  vi.restoreAllMocks()
})

describe('print PDF preference', () => {
  it('defaults to unchecked and persists changes', () => {
    const checkbox = document.createElement('input')
    checkbox.type = 'checkbox'

    const getPdfMode = bindPrintPdfPreference(checkbox)

    expect(checkbox.checked).toBe(false)
    expect(getPdfMode()).toBe(false)
    checkbox.checked = true
    checkbox.dispatchEvent(new Event('change'))
    expect(localStorage.getItem(LABEL_PRINT_PDF_MODE_KEY)).toBe('true')
    expect(getPdfMode()).toBe(true)
  })

  it('restores an enabled compatibility preference', () => {
    localStorage.setItem(LABEL_PRINT_PDF_MODE_KEY, 'true')
    const checkbox = document.createElement('input')
    checkbox.type = 'checkbox'

    const getPdfMode = bindPrintPdfPreference(checkbox)

    expect(checkbox.checked).toBe(true)
    expect(getPdfMode()).toBe(true)
  })
})

describe('PDF output destination routing', () => {
  it('keeps Export PDF on pdf.save()', async () => {
    const pdf = makePdfDocument()
    const open = vi.spyOn(window, 'open')
    const actions = bindPdfOutputActions({
      pdfButton: document.querySelector('#pdf')!,
      createPdf: vi.fn(async () => pdf),
      getFilename: () => 'label.pdf',
      getTranslation: (_key, fallback) => fallback,
    })

    await actions.download()

    expect(pdf.save).toHaveBeenCalledWith('label.pdf')
    expect(pdf.output).not.toHaveBeenCalled()
    expect(open).not.toHaveBeenCalled()
    expect(URL.createObjectURL).not.toHaveBeenCalled()
  })

  it('opens the tab before asynchronous PDF creation resolves', async () => {
    const pdf = makePdfDocument()
    const { popup, replace } = makePopup()
    const open = vi.spyOn(window, 'open').mockReturnValue(popup)
    let resolvePdf!: (value: LabelPdfDocument) => void
    const pendingPdf = new Promise<LabelPdfDocument>(
      resolve => {
        resolvePdf = resolve
      },
    )
    const actions = bindPdfOutputActions({
      pdfButton: document.querySelector('#pdf')!,
      createPdf: vi.fn(() => pendingPdf),
      getFilename: () => 'label.pdf',
      getTranslation: (_key, fallback) => fallback,
    })

    const printPromise = actions.print()

    expect(open).toHaveBeenCalledWith('', '_blank')
    expect(replace).not.toHaveBeenCalled()

    resolvePdf(pdf)
    await printPromise

    expect(pdf.save).not.toHaveBeenCalled()
    expect(pdf.output).toHaveBeenCalledWith('blob')
    expect(URL.createObjectURL).toHaveBeenCalledOnce()
    expect(replace).toHaveBeenCalledWith(
      'blob:filaman-print-pdf',
    )
  })

  it('does not use either browser HTML print API', async () => {
    const pdf = makePdfDocument()
    const { popup } = makePopup()
    vi.spyOn(window, 'open').mockReturnValue(popup)
    const windowPrint = vi
      .spyOn(window, 'print')
      .mockImplementation(() => undefined)
    const execCommand = vi.fn()
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: execCommand,
    })
    const actions = bindPdfOutputActions({
      pdfButton: document.querySelector('#pdf')!,
      createPdf: vi.fn(async () => pdf),
      getFilename: () => 'label.pdf',
      getTranslation: (_key, fallback) => fallback,
    })

    await actions.print()

    expect(windowPrint).not.toHaveBeenCalled()
    expect(execCommand).not.toHaveBeenCalled()
  })

  it('reports a blocked PDF viewer without downloading', async () => {
    const pdf = makePdfDocument()
    vi.spyOn(window, 'open').mockReturnValue(null)
    const alert = vi
      .spyOn(window, 'alert')
      .mockImplementation(() => undefined)
    const createPdf = vi.fn(async () => pdf)
    const actions = bindPdfOutputActions({
      pdfButton: document.querySelector('#pdf')!,
      createPdf,
      getFilename: () => 'label.pdf',
      getTranslation: (_key, fallback) => fallback,
    })

    await actions.print()

    expect(alert).toHaveBeenCalledWith(
      'Allow pop-ups to open the print PDF.',
    )
    expect(createPdf).not.toHaveBeenCalled()
    expect(pdf.save).not.toHaveBeenCalled()
    expect(pdf.output).not.toHaveBeenCalled()
  })

  it('closes the temporary tab when PDF creation fails', async () => {
    const { popup, close } = makePopup()
    vi.spyOn(window, 'open').mockReturnValue(popup)
    const alert = vi
      .spyOn(window, 'alert')
      .mockImplementation(() => undefined)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const actions = bindPdfOutputActions({
      pdfButton: document.querySelector('#pdf')!,
      createPdf: vi.fn(async () => {
        throw new Error('capture failed')
      }),
      getFilename: () => 'label.pdf',
      getTranslation: (_key, fallback) => fallback,
    })

    await actions.print()

    expect(close).toHaveBeenCalledOnce()
    expect(alert).toHaveBeenCalledWith(
      'Print PDF generation failed.',
    )
  })

  it('closes a cancelled Print popup without producing output or an alert', async () => {
    const { popup, close } = makePopup()
    vi.spyOn(window, 'open').mockReturnValue(popup)
    const alert = vi
      .spyOn(window, 'alert')
      .mockImplementation(() => undefined)
    const download = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined)
    const actions = bindPdfOutputActions({
      pdfButton: document.querySelector('#pdf')!,
      createPdf: vi.fn(async () => null),
      getFilename: () => 'label.pdf',
      getTranslation: (_key, fallback) => fallback,
    })

    await actions.print()

    expect(close).toHaveBeenCalledOnce()
    expect(URL.createObjectURL).not.toHaveBeenCalled()
    expect(download).not.toHaveBeenCalled()
    expect(alert).not.toHaveBeenCalled()
  })

  it('immediately revokes a Blob URL when viewer navigation fails', async () => {
    const pdf = makePdfDocument()
    const { popup, close, replace } = makePopup()
    replace.mockImplementation(() => {
      throw new Error('navigation failed')
    })
    vi.spyOn(window, 'open').mockReturnValue(popup)
    const alert = vi
      .spyOn(window, 'alert')
      .mockImplementation(() => undefined)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const actions = bindPdfOutputActions({
      pdfButton: document.querySelector('#pdf')!,
      createPdf: vi.fn(async () => pdf),
      getFilename: () => 'label.pdf',
      getTranslation: (_key, fallback) => fallback,
    })

    await actions.print()

    expect(close).toHaveBeenCalledOnce()
    expect(alert).toHaveBeenCalledWith(
      'Print PDF generation failed.',
    )
    expect(URL.revokeObjectURL).toHaveBeenCalledOnce()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(
      'blob:filaman-print-pdf',
    )

    releasePrintPdfUrls()
    expect(URL.revokeObjectURL).toHaveBeenCalledOnce()
  })

  it('revokes generated Blob URLs when the source page is released', async () => {
    const pdf = makePdfDocument()
    const { popup } = makePopup()
    vi.spyOn(window, 'open').mockReturnValue(popup)
    const actions = bindPdfOutputActions({
      pdfButton: document.querySelector('#pdf')!,
      createPdf: vi.fn(async () => pdf),
      getFilename: () => 'label.pdf',
      getTranslation: (_key, fallback) => fallback,
    })

    await actions.print()
    releasePrintPdfUrls()

    expect(URL.revokeObjectURL).toHaveBeenCalledWith(
      'blob:filaman-print-pdf',
    )
  })
})

describe('single and batch PDF factory reuse', () => {
  it.each(['single-label', 'batch'] as const)(
    'uses normal browser printing by default for %s output',
    async kind => {
      document.body.innerHTML = `
        <button id="print">Print</button>
        <button id="png">Export PNG</button>
        <button id="aml">Export AML</button>
        <button id="pdf">Export PDF</button>
        <input id="pdf-mode" type="checkbox">
        <div id="label"></div>
      `
      const windowPrint = vi.spyOn(window, 'print')
        .mockImplementation(() => undefined)
      const open = vi.spyOn(window, 'open')
      const captureLabel = vi.fn(
        async () => 'data:image/png;base64,bGFiZWw=',
      )

      const { printButton } = bindDeferredCapture(kind, captureLabel)
      printButton.click()

      await vi.waitFor(() => expect(windowPrint).toHaveBeenCalledOnce())
      expect(printLabelBrowserJob).toHaveBeenCalledOnce()
      expect(captureLabel).not.toHaveBeenCalled()
      expect(open).not.toHaveBeenCalled()
    },
  )

  it('reports browser-print preparation failure without falling back to PDF', async () => {
    document.body.innerHTML = `
      <button id="print">Print</button>
      <button id="png">Export PNG</button>
      <button id="aml">Export AML</button>
      <button id="pdf">Export PDF</button>
      <input id="pdf-mode" type="checkbox">
      <div id="label"></div>
    `
    const alert = vi.spyOn(window, 'alert')
      .mockImplementation(() => undefined)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.mocked(printLabelBrowserJob).mockRejectedValueOnce(
      new Error('print failed'),
    )
    const open = vi.spyOn(window, 'open')
    const { printButton, pngButton, amlButton, pdfButton } =
      bindDeferredCapture(
        'single-label',
        vi.fn(async () => 'data:image/png;base64,bGFiZWw='),
      )

    printButton.click()

    await vi.waitFor(() => {
      expect(alert).toHaveBeenCalledWith('Browser printing failed.')
    })
    expect(cleanupLabelBrowserPrint).toHaveBeenCalledOnce()
    expect(open).not.toHaveBeenCalled()
    expect([printButton, pngButton, amlButton, pdfButton]
      .every(button => !button.disabled)).toBe(true)
  })

  it.each(['single-label', 'batch'] as const)(
    'prevents a competing %s action from starting a second capture',
    async kind => {
      document.body.innerHTML = `
        <button id="print">Print</button>
        <button id="png">Export PNG</button>
        <button id="aml">Export AML</button>
        <button id="pdf">Export PDF</button>
        <input id="pdf-mode" type="checkbox">
        <div id="label"></div>
      `
      let resolveCapture!: (value: string) => void
      const pendingCapture = new Promise<string>(resolve => {
        resolveCapture = resolve
      })
      const captureLabel = vi.fn(() => pendingCapture)
      const popup = makePopup()
      vi.spyOn(window, 'open').mockReturnValue(popup.popup)
      vi.spyOn(HTMLAnchorElement.prototype, 'click')
        .mockImplementation(() => undefined)

      const { printButton, pngButton, amlButton, pdfButton } =
        bindDeferredCapture(kind, captureLabel)
      const buttons = [printButton, pngButton, amlButton, pdfButton]
      pngButton.click()
      await vi.waitFor(() => {
        expect(captureLabel).toHaveBeenCalledOnce()
      })

      printButton.dispatchEvent(new MouseEvent('click'))
      await Promise.resolve()
      await Promise.resolve()

      expect(captureLabel).toHaveBeenCalledOnce()
      expect(buttons.every(button => button.disabled)).toBe(true)

      resolveCapture(`data:image/png;base64,${kind}`)
      await vi.waitFor(() => {
        expect(buttons.every(button => !button.disabled)).toBe(true)
      })
      expect(buttons.map(button => button.textContent)).toEqual([
        'Print',
        'Export PNG',
        'Export AML',
        'Export PDF',
      ])
    },
  )

  it.each([
    {
      initialMode: 'individual',
      finalMode: 'sheet',
      actionButtonId: 'png',
    },
    {
      initialMode: 'sheet',
      finalMode: 'individual',
      actionButtonId: 'pdf',
    },
  ] as const)(
    'preserves $finalMode export state when output mode changes from $initialMode during an operation',
    async ({ initialMode, finalMode, actionButtonId }) => {
      document.body.innerHTML = `
        <button id="print">Print</button>
        <button id="png">Export PNG</button>
        <button id="aml">Export AML</button>
        <button id="pdf">Export PDF</button>
        <input id="pdf-mode" type="checkbox">
        <div id="label"></div>
      `
      let mode: 'individual' | 'sheet' = initialMode
      const sheetControls = {
        getOutputMode: () => mode,
      } as LabelSheetControls
      const pngButton = document.querySelector<HTMLButtonElement>('#png')!
      const amlButton = document.querySelector<HTMLButtonElement>('#aml')!
      const syncExportState = () => syncLabelSheetIndividualExportState(
        sheetControls,
        [pngButton, amlButton],
        (_key, fallback) => fallback,
      )
      syncExportState()

      let resolveCapture!: (value: string) => void
      const captureLabel = vi.fn(() => new Promise<string>(resolve => {
        resolveCapture = resolve
      }))
      vi.spyOn(HTMLAnchorElement.prototype, 'click')
        .mockImplementation(() => undefined)
      const { printButton, pdfButton } = bindDeferredCapture(
        'single-label',
        captureLabel,
      )

      document.querySelector<HTMLButtonElement>(`#${actionButtonId}`)!.click()
      await vi.waitFor(() => expect(captureLabel).toHaveBeenCalledOnce())

      mode = finalMode
      syncExportState()
      resolveCapture('data:image/png;base64,bGFiZWw=')

      await vi.waitFor(() => {
        expect(pdfButton.textContent).toBe('Export PDF')
      })
      const finalSheetMode = finalMode === 'sheet'
      expect(pngButton.disabled).toBe(finalSheetMode)
      expect(amlButton.disabled).toBe(finalSheetMode)
      expect(printButton.disabled).toBe(false)
      expect(pdfButton.disabled).toBe(false)
    },
  )

  it('runs batch PNG export from the supplied button', async () => {
    document.body.innerHTML = `
      <button id="print">Print</button>
      <button id="png">Export PNG</button>
      <button id="aml">Export AML</button>
      <button id="pdf">Export PDF</button>
      <input id="pdf-mode" type="checkbox">
    `
    const downloads: Array<{ filename: string; href: string }> = []
    vi.spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function(this: HTMLAnchorElement) {
        downloads.push({
          filename: this.download,
          href: this.href,
        })
      })

    bindBatchLabelExport({
      entities: () => [{ id: 1 }],
      activeTab: () => 'print',
      printButton: document.querySelector('#print')!,
      printPdfCheckbox: document.querySelector('#pdf-mode')!,
      pngButton: document.querySelector('#png')!,
      amlButton: document.querySelector('#aml')!,
      pdfButton: document.querySelector('#pdf')!,
      getTranslation: (_key, fallback) => fallback,
      renderAll: vi.fn(async () => undefined),
      captureLabel: vi.fn(
        async () => 'data:image/png;base64,label-1',
      ),
      getPdfDimensions: () => ({ widthMm: 60, heightMm: 40 }),
      singlePngName: entity => `label-${entity.id}.png`,
      zipName: () => 'labels.zip',
      zipEntryName: entity => `label-${entity.id}.png`,
      pdfName: () => 'batch-labels.pdf',
      browserPrint: makeBrowserPrintBinding(),
    })

    document.querySelector<HTMLButtonElement>('#png')!.click()

    await vi.waitFor(() => {
      expect(downloads).toEqual([{
        filename: 'label-1.png',
        href: 'data:image/png;base64,label-1',
      }])
    })
  })

  it('downloads one batch AML file built from the captured PNG', async () => {
    document.body.innerHTML = `
      <button id="print">Print</button>
      <button id="png">Export PNG</button>
      <button id="aml">Export AML</button>
      <button id="pdf">Export PDF</button>
      <input id="pdf-mode" type="checkbox">
    `
    let amlBlob: Blob | undefined
    vi.mocked(URL.createObjectURL).mockImplementation(value => {
      amlBlob = value as Blob
      return 'blob:label-aml'
    })
    const downloads: Array<{ filename: string; href: string }> = []
    vi.spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function(this: HTMLAnchorElement) {
        downloads.push({ filename: this.download, href: this.href })
      })
    const captureLabel = vi.fn(
      async () => 'data:image/png;base64,bGFiZWw=',
    )

    bindBatchLabelExport({
      entities: () => [{ id: 1 }],
      activeTab: () => 'print',
      printButton: document.querySelector('#print')!,
      printPdfCheckbox: document.querySelector('#pdf-mode')!,
      pngButton: document.querySelector('#png')!,
      amlButton: document.querySelector('#aml')!,
      pdfButton: document.querySelector('#pdf')!,
      getTranslation: (_key, fallback) => fallback,
      renderAll: vi.fn(async () => undefined),
      captureLabel,
      getPdfDimensions: () => ({ widthMm: 48, heightMm: 30 }),
      singlePngName: entity => `label-${entity.id}.png`,
      zipName: () => 'labels.zip',
      zipEntryName: entity => `label-${entity.id}.png`,
      pdfName: () => 'batch-labels.pdf',
      browserPrint: makeBrowserPrintBinding(),
    })

    document.querySelector<HTMLButtonElement>('#aml')!.click()

    await vi.waitFor(() => {
      expect(downloads).toEqual([{
        filename: 'label-1.aml',
        href: 'blob:label-aml',
      }])
    })
    const aml = await amlBlob!.text()
    expect(aml).toContain('<labelWidth>48.000</labelWidth>')
    expect(aml).toContain('<labelHeight>30.000</labelHeight>')
    expect(aml).toContain('<content>bGFiZWw=</content>')
    expect(captureLabel).toHaveBeenCalledOnce()
  })

  it('packages multiple batch AML labels using PNG-equivalent names', async () => {
    document.body.innerHTML = `
      <button id="print">Print</button>
      <button id="png">Export PNG</button>
      <button id="aml">Export AML</button>
      <button id="pdf">Export PDF</button>
      <input id="pdf-mode" type="checkbox">
    `
    let archiveBlob: Blob | undefined
    vi.mocked(URL.createObjectURL).mockImplementation(value => {
      archiveBlob = value as Blob
      return 'blob:label-aml-zip'
    })
    const downloads: string[] = []
    vi.spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function(this: HTMLAnchorElement) {
        downloads.push(this.download)
      })

    bindBatchLabelExport({
      entities: () => [{ id: 1 }, { id: 2 }],
      activeTab: () => 'print',
      printButton: document.querySelector('#print')!,
      printPdfCheckbox: document.querySelector('#pdf-mode')!,
      pngButton: document.querySelector('#png')!,
      amlButton: document.querySelector('#aml')!,
      pdfButton: document.querySelector('#pdf')!,
      getTranslation: (_key, fallback) => fallback,
      renderAll: vi.fn(async () => undefined),
      captureLabel: vi.fn(async entity =>
        `data:image/png;base64,${entity.id === 1 ? 'b25l' : 'dHdv'}`,
      ),
      getPdfDimensions: () => ({ widthMm: 48, heightMm: 30 }),
      singlePngName: entity => `label-${entity.id}.png`,
      zipName: () => 'labels.zip',
      zipEntryName: entity => `label-${entity.id}.png`,
      pdfName: () => 'batch-labels.pdf',
      browserPrint: makeBrowserPrintBinding(),
    })

    document.querySelector<HTMLButtonElement>('#aml')!.click()

    await vi.waitFor(() => {
      expect(downloads).toEqual(['labels-aml.zip'])
    })
    const zip = await JSZip.loadAsync(await archiveBlob!.arrayBuffer())
    expect(Object.keys(zip.files)).toEqual(['label-1.aml', 'label-2.aml'])
    expect(await zip.file('label-2.aml')!.async('text'))
      .toContain('<content>dHdv</content>')
  })

  it('downloads one AML file from the shared single-label capture', async () => {
    document.body.innerHTML = `
      <button id="print">Print</button>
      <button id="png">Export PNG</button>
      <button id="aml">Export AML</button>
      <button id="pdf">Export PDF</button>
      <input id="pdf-mode" type="checkbox">
      <div id="label"></div>
    `
    let amlBlob: Blob | undefined
    vi.mocked(URL.createObjectURL).mockImplementation(value => {
      amlBlob = value as Blob
      return 'blob:single-label-aml'
    })
    const download = vi.spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined)
    const refreshPreview = vi.fn(async () => undefined)
    const captureLabel = vi.fn(
      async () => 'data:image/png;base64,c2luZ2xl',
    )

    bindSingleLabelExport({
      printButton: document.querySelector('#print')!,
      printPdfCheckbox: document.querySelector('#pdf-mode')!,
      exportPngBtn: document.querySelector('#png')!,
      exportAmlBtn: document.querySelector('#aml')!,
      exportPdfBtn: document.querySelector('#pdf')!,
      labelElement: document.querySelector('#label')!,
      getTranslation: (_key, fallback) => fallback,
      buildBaseName: () => 'single-label',
      getDimensions: () => ({ widthMm: 60, heightMm: 40 }),
      refreshPreview,
      captureLabel,
      browserPrint: makeBrowserPrintBinding(),
    })

    document.querySelector<HTMLButtonElement>('#aml')!.click()

    await vi.waitFor(() => expect(download).toHaveBeenCalledOnce())
    expect(refreshPreview).toHaveBeenCalledOnce()
    expect(captureLabel).toHaveBeenCalledOnce()
    expect(await amlBlob!.text()).toContain(
      '<content>c2luZ2xl</content>',
    )
  })

  it('reports AML capture failures and restores every output control', async () => {
    document.body.innerHTML = `
      <button id="print">Print</button>
      <button id="png">Export PNG</button>
      <button id="aml">Export AML</button>
      <button id="pdf">Export PDF</button>
      <input id="pdf-mode" type="checkbox">
      <div id="label"></div>
    `
    const alert = vi.spyOn(window, 'alert')
      .mockImplementation(() => undefined)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    bindDeferredCapture(
      'single-label',
      vi.fn(async () => {
        throw new Error('capture failed')
      }),
    )

    document.querySelector<HTMLButtonElement>('#aml')!.click()

    await vi.waitFor(() => {
      expect(alert).toHaveBeenCalledWith('AML export failed.')
    })
    expect([
      ...document.querySelectorAll<HTMLButtonElement>('button'),
    ].every(button => !button.disabled)).toBe(true)
  })

  it.each([
    { format: 'PNG', buttonId: 'png', entities: [{ id: 1 }] },
    { format: 'PNG', buttonId: 'png', entities: [{ id: 1 }, { id: 2 }] },
    { format: 'AML', buttonId: 'aml', entities: [{ id: 1 }] },
    { format: 'AML', buttonId: 'aml', entities: [{ id: 1 }, { id: 2 }] },
  ])(
    'reports $format export failure when every one of $entities.length batch capture(s) fails',
    async ({ format, buttonId, entities }) => {
      document.body.innerHTML = `
        <button id="print">Print</button>
        <button id="png">Export PNG</button>
        <button id="aml">Export AML</button>
        <button id="pdf">Export PDF</button>
        <input id="pdf-mode" type="checkbox">
      `
      const alert = vi.spyOn(window, 'alert')
        .mockImplementation(() => undefined)
      vi.spyOn(console, 'error').mockImplementation(() => undefined)
      const download = vi.spyOn(HTMLAnchorElement.prototype, 'click')
        .mockImplementation(() => undefined)

      bindBatchLabelExport({
        entities: () => entities,
        activeTab: () => 'print',
        printButton: document.querySelector('#print')!,
        printPdfCheckbox: document.querySelector('#pdf-mode')!,
        pngButton: document.querySelector('#png')!,
        amlButton: document.querySelector('#aml')!,
        pdfButton: document.querySelector('#pdf')!,
        getTranslation: (_key, fallback) => fallback,
        renderAll: vi.fn(async () => undefined),
        captureLabel: vi.fn(async () => {
          throw new Error('capture failed')
        }),
        getPdfDimensions: () => ({ widthMm: 48, heightMm: 30 }),
        singlePngName: entity => `label-${entity.id}.png`,
        zipName: () => 'labels.zip',
        zipEntryName: entity => `label-${entity.id}.png`,
        pdfName: () => 'batch-labels.pdf',
        browserPrint: makeBrowserPrintBinding(),
        skipCaptureErrorsInZip: true,
      })

      document.querySelector<HTMLButtonElement>(`#${buttonId}`)!.click()

      await vi.waitFor(() => {
        expect(alert).toHaveBeenCalledWith(`${format} export failed.`)
      })
      expect(download).not.toHaveBeenCalled()
    },
  )

  it.each([
    { format: 'PNG', buttonId: 'png', archiveName: 'labels.zip', entryName: 'label-2.png' },
    { format: 'AML', buttonId: 'aml', archiveName: 'labels-aml.zip', entryName: 'label-2.aml' },
  ])(
    'keeps a partial $format batch export in its ZIP',
    async ({ buttonId, archiveName, entryName }) => {
      document.body.innerHTML = `
        <button id="print">Print</button>
        <button id="png">Export PNG</button>
        <button id="aml">Export AML</button>
        <button id="pdf">Export PDF</button>
        <input id="pdf-mode" type="checkbox">
      `
      let archiveBlob: Blob | undefined
      vi.mocked(URL.createObjectURL).mockImplementation(value => {
        archiveBlob = value as Blob
        return 'blob:partial-label-zip'
      })
      const downloads: string[] = []
      vi.spyOn(HTMLAnchorElement.prototype, 'click')
        .mockImplementation(function(this: HTMLAnchorElement) {
          downloads.push(this.download)
        })

      bindBatchLabelExport({
        entities: () => [{ id: 1 }, { id: 2 }],
        activeTab: () => 'print',
        printButton: document.querySelector('#print')!,
        printPdfCheckbox: document.querySelector('#pdf-mode')!,
        pngButton: document.querySelector('#png')!,
        amlButton: document.querySelector('#aml')!,
        pdfButton: document.querySelector('#pdf')!,
        getTranslation: (_key, fallback) => fallback,
        renderAll: vi.fn(async () => undefined),
        captureLabel: vi.fn(async entity => {
          if (entity.id === 1) throw new Error('capture failed')
          return 'data:image/png;base64,c3Vydml2b3I='
        }),
        getPdfDimensions: () => ({ widthMm: 48, heightMm: 30 }),
        singlePngName: entity => `label-${entity.id}.png`,
        zipName: () => 'labels.zip',
        zipEntryName: entity => `label-${entity.id}.png`,
        pdfName: () => 'batch-labels.pdf',
        browserPrint: makeBrowserPrintBinding(),
        skipCaptureErrorsInZip: true,
      })

      document.querySelector<HTMLButtonElement>(`#${buttonId}`)!.click()

      await vi.waitFor(() => expect(downloads).toEqual([archiveName]))
      const zip = await JSZip.loadAsync(await archiveBlob!.arrayBuffer())
      expect(Object.keys(zip.files)).toEqual([entryName])
    },
  )

  it('passes the same single-label pages to Export PDF and Print', async () => {
    document.body.innerHTML = `
      <button id="print">Print</button>
      <button id="png">Export PNG</button>
      <button id="aml">Export AML</button>
      <button id="pdf">Export PDF</button>
      <input id="pdf-mode" type="checkbox">
      <div id="label"></div>
    `
    const firstPdf = makePdfDocument()
    const secondPdf = makePdfDocument()
    const createPdf = vi
      .fn()
      .mockResolvedValueOnce(firstPdf)
      .mockResolvedValueOnce(secondPdf)
    const label = document.querySelector('#label') as HTMLElement
    const popup = makePopup()
    vi.spyOn(window, 'open').mockReturnValue(popup.popup)

    bindSingleLabelExport({
      printButton: document.querySelector('#print')!,
      printPdfCheckbox: document.querySelector('#pdf-mode')!,
      exportPngBtn: document.querySelector('#png')!,
      exportAmlBtn: document.querySelector('#aml')!,
      exportPdfBtn: document.querySelector('#pdf')!,
      labelElement: label,
      getTranslation: (_key, fallback) => fallback,
      buildBaseName: () => 'single-label',
      pdfName: () => 'single-label.pdf',
      getDimensions: () => ({ widthMm: 60, heightMm: 40 }),
      refreshPreview: vi.fn(async () => undefined),
      captureLabel: vi.fn(
        async () => 'data:image/png;base64,single',
      ),
      browserPrint: makeBrowserPrintBinding(label),
      createPdf: async (pages, defaultCreate) => {
        expect(pages).toEqual([
          {
            dataUrl: 'data:image/png;base64,single',
            widthMm: 60,
            heightMm: 40,
          },
        ])
        await defaultCreate()
        return createPdf()
      },
    })

    document.querySelector<HTMLButtonElement>('#pdf')!.click()
    await vi.waitFor(() => {
      expect(firstPdf.save).toHaveBeenCalledWith(
        'single-label.pdf',
      )
    })

    document.querySelector<HTMLInputElement>('#pdf-mode')!.checked = true
    document.querySelector<HTMLButtonElement>('#print')!.click()
    await vi.waitFor(() => {
      expect(secondPdf.output).toHaveBeenCalledWith('blob')
    })

    expect(createPdf).toHaveBeenCalledTimes(2)
  })

  it('passes identical deterministic batch pages to both destinations', async () => {
    document.body.innerHTML = `
      <button id="print">Print</button>
      <button id="png">Export PNG</button>
      <button id="aml">Export AML</button>
      <button id="pdf">Export PDF</button>
      <input id="pdf-mode" type="checkbox">
    `
    const firstPdf = makePdfDocument()
    const secondPdf = makePdfDocument()
    const builtPages: unknown[] = []
    const popup = makePopup()
    vi.spyOn(window, 'open').mockReturnValue(popup.popup)

    bindBatchLabelExport({
      entities: () => [{ id: 1 }, { id: 2 }],
      activeTab: () => 'print',
      printButton: document.querySelector('#print')!,
      printPdfCheckbox: document.querySelector('#pdf-mode')!,
      pngButton: document.querySelector('#png')!,
      amlButton: document.querySelector('#aml')!,
      pdfButton: document.querySelector('#pdf')!,
      getTranslation: (_key, fallback) => fallback,
      renderAll: vi.fn(async () => undefined),
      captureLabel: vi.fn(async entity =>
        `data:image/png;base64,label-${entity.id}`,
      ),
      getPdfDimensions: () => ({
        widthMm: 60,
        heightMm: 40,
      }),
      singlePngName: entity => `label-${entity.id}.png`,
      zipName: () => 'labels.zip',
      zipEntryName: entity => `label-${entity.id}.png`,
      pdfName: () => 'batch-labels.pdf',
      browserPrint: makeBrowserPrintBinding(),
      createPdf: async (pages, defaultCreate) => {
        builtPages.push(structuredClone(pages))
        await defaultCreate()
        return builtPages.length === 1 ? firstPdf : secondPdf
      },
    })

    document.querySelector<HTMLButtonElement>('#pdf')!.click()
    await vi.waitFor(() => {
      expect(firstPdf.save).toHaveBeenCalledWith(
        'batch-labels.pdf',
      )
    })

    document.querySelector<HTMLInputElement>('#pdf-mode')!.checked = true
    document.querySelector<HTMLButtonElement>('#print')!.click()
    await vi.waitFor(() => {
      expect(secondPdf.output).toHaveBeenCalledWith('blob')
    })

    expect(builtPages).toHaveLength(2)
    expect(builtPages[0]).toEqual(builtPages[1])
  })
})
