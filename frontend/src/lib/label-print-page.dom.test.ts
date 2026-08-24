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
  appendLabelSettingsCheckbox,
  bindLabelOutputPreview,
  bindLabelOutputs,
  bindLabelPreviewZoom,
  bindLabelSettingsEvents,
  bindPdfOutputActions,
  bindPrintPageSidebarCollapse,
  bindPrintPdfPreference,
  captureLabelSettings,
  getLabelOutputControls,
  getLabelSettingsControls,
  getStandardLabelSettings,
  readVersionedLabelSettings,
  releasePrintPdfUrls,
  resetLabelSettings,
  restoreLabelSettings,
  type LabelPdfFactoryOverride,
} from './label-print-page'
import type { LabelPdfDocument, LabelPdfPage } from './label-export'
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

function bindSingleCollectionOutputs(options: {
  printButton: HTMLButtonElement
  printPdfCheckbox: HTMLInputElement
  exportPngBtn: HTMLButtonElement
  exportAmlBtn: HTMLButtonElement
  exportPdfBtn: HTMLButtonElement
  labelElement: HTMLElement
  getTranslation(key: string, fallback: string): string
  buildBaseName(): string
  pdfName?(): string
  getDimensions(): { widthMm: number; heightMm: number }
  refreshPreview(): Promise<void>
  captureLabel(): Promise<string>
  browserPrint: ReturnType<typeof makeBrowserPrintBinding>
  createPdf?: LabelPdfFactoryOverride
}) {
  bindLabelOutputs({
    controls: {
      printButton: options.printButton,
      printPdfCheckbox: options.printPdfCheckbox,
      pngButton: options.exportPngBtn,
      amlButton: options.exportAmlBtn,
      pdfButton: options.exportPdfBtn,
    },
    collection: {
      getItems: () => [options.labelElement],
      prepare: options.refreshPreview,
      capture: options.captureLabel,
      getDimensions: options.getDimensions,
      browserPrint: {
        ...options.browserPrint,
        getIndividualPages: () => [options.labelElement],
      },
      pngName: () => `${options.buildBaseName()}.png`,
      pngArchiveName: () => `${options.buildBaseName()}.zip`,
      pdfName: options.pdfName ?? (() => `${options.buildBaseName()}.pdf`),
      allowPartialPng: false,
      allowPartialPdf: false,
    },
    getTranslation: options.getTranslation,
    createPdf: options.createPdf,
  })
}

function bindBatchCollectionOutputs<T>(options: {
  entities(): T[]
  activeTab(): 'print' | 'designer'
  printButton: HTMLButtonElement
  printPdfCheckbox: HTMLInputElement
  pngButton: HTMLButtonElement
  amlButton: HTMLButtonElement
  pdfButton: HTMLButtonElement
  getTranslation(key: string, fallback: string): string
  renderAll(tab: 'print' | 'designer'): Promise<void>
  captureLabel(entity: T): Promise<string>
  getPdfDimensions(): { widthMm: number; heightMm: number }
  singlePngName(entity: T): string
  zipName(): string
  zipEntryName(entity: T): string
  pdfName(): string
  browserPrint: ReturnType<typeof makeBrowserPrintBinding>
  createPdf?: LabelPdfFactoryOverride
  skipCaptureErrorsInZip?: boolean
  skipCaptureErrorsInPdf?: boolean
}) {
  bindLabelOutputs({
    controls: {
      printButton: options.printButton,
      printPdfCheckbox: options.printPdfCheckbox,
      pngButton: options.pngButton,
      amlButton: options.amlButton,
      pdfButton: options.pdfButton,
    },
    collection: {
      getItems: options.entities,
      prepare: () => options.renderAll(options.activeTab()),
      capture: options.captureLabel,
      getDimensions: options.getPdfDimensions,
      browserPrint: options.browserPrint,
      pngName: (entity, _index, total) => total === 1
        ? options.singlePngName(entity)
        : options.zipEntryName(entity),
      pngArchiveName: options.zipName,
      pdfName: options.pdfName,
      allowPartialPng: options.skipCaptureErrorsInZip ?? false,
      allowPartialPdf: options.skipCaptureErrorsInPdf ?? false,
    },
    getTranslation: options.getTranslation,
    createPdf: options.createPdf,
  })
}

function renderPrintPageControls() {
  document.body.innerHTML = `
    <div id="fm-page"></div>
    <main class="preview-container">
      <button id="preview-zoom-out">Zoom out</button>
      <input id="preview-zoom-slider" type="range" min="50" max="300" step="5" value="100">
      <button id="preview-zoom-in">Zoom in</button>
      <span id="preview-zoom-label">100%</span>
      <button id="preview-zoom-reset">Reset zoom</button>
      <div class="preview-scroll-area">
        <div id="label-preview"></div>
      </div>
    </main>
    <input id="input-width" type="number">
    <input id="input-height" type="number">
    <input id="input-font-size" type="range">
    <input id="input-qr-size" type="number">
    <input id="check-logo" type="checkbox">
    <input id="check-qr" type="checkbox">
    <input id="check-id" type="checkbox">
    <input id="check-mfr" type="checkbox">
    <input id="check-mat" type="checkbox">
    <input id="check-color" type="checkbox">
    <input id="check-color-swatch" type="checkbox">
    <input id="check-color-hex" type="checkbox">
    <button id="btn-print">Print</button>
    <input id="check-print-pdf" type="checkbox">
    <button id="btn-export-png">PNG</button>
    <button id="btn-export-aml">AML</button>
    <button id="btn-export-pdf">PDF</button>
  `
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
    bindSingleCollectionOutputs({
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
    bindBatchCollectionOutputs({
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

function bindCollectionOutputs(
  items: number[],
  options: {
    allowPartialPng?: boolean
    allowPartialPdf?: boolean
    capture?: (item: number) => Promise<string>
    createPdf?: (pages: LabelPdfPage[]) => Promise<LabelPdfDocument | null>
    getIndividualPages?: () => HTMLElement[]
    getTranslation?: (key: string, fallback: string) => string
    prepare?: () => Promise<void>
    pngName?: (item: number, index: number, total: number) => string
  } = {},
) {
  document.body.innerHTML = `
    <button id="print">Print</button>
    <button id="png">Export PNG</button>
    <button id="aml">Export AML</button>
    <button id="pdf">Export PDF</button>
    <input id="pdf-mode" type="checkbox">
  `
  const controls = {
    printButton: document.querySelector<HTMLButtonElement>('#print')!,
    printPdfCheckbox:
      document.querySelector<HTMLInputElement>('#pdf-mode')!,
    pngButton: document.querySelector<HTMLButtonElement>('#png')!,
    amlButton: document.querySelector<HTMLButtonElement>('#aml')!,
    pdfButton: document.querySelector<HTMLButtonElement>('#pdf')!,
  }
  const sheetControls = {
    getOutputMode: () => 'individual',
    getSettings: () => (
      {} as ReturnType<LabelSheetControls['getSettings']>
    ),
  } as LabelSheetControls
  const capture = options.capture ?? vi.fn(async item =>
    `data:image/png;base64,aXRlbS0${item}`,
  )
  const prepare = options.prepare ?? vi.fn(async () => undefined)
  const pages = options.getIndividualPages ?? (() => [document.body])

  bindLabelOutputs({
    controls,
    collection: {
      getItems: () => items,
      prepare,
      capture,
      getDimensions: () => ({ widthMm: 48, heightMm: 30 }),
      browserPrint: {
        previewRoot: document.body,
        sheetControls,
        getIndividualPages: pages,
      },
      pngName: options.pngName ?? (item => `label-${item}.png`),
      pngArchiveName: () => 'labels.zip',
      pdfName: () => 'labels.pdf',
      allowPartialPng: options.allowPartialPng ?? false,
      allowPartialPdf: options.allowPartialPdf ?? false,
    },
    getTranslation: options.getTranslation ?? ((key, fallback) =>
      key === 'labelPrint.pngExportFailed' ? 'Translated PNG failure.' : fallback),
    createPdf: options.createPdf,
  })

  return { controls, capture, prepare }
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

describe('shared print-page controls', () => {
  it('returns the existing output and label-setting controls', () => {
    renderPrintPageControls()

    const output = getLabelOutputControls()
    const settings = getLabelSettingsControls()

    expect(output).toEqual({
      printButton: document.querySelector('#btn-print'),
      printPdfCheckbox: document.querySelector('#check-print-pdf'),
      pngButton: document.querySelector('#btn-export-png'),
      amlButton: document.querySelector('#btn-export-aml'),
      pdfButton: document.querySelector('#btn-export-pdf'),
    })
    expect(settings).toEqual({
      width: document.querySelector('#input-width'),
      height: document.querySelector('#input-height'),
      fontSize: document.querySelector('#input-font-size'),
      qrSize: document.querySelector('#input-qr-size'),
      showLogo: document.querySelector('#check-logo'),
      showQr: document.querySelector('#check-qr'),
      showId: document.querySelector('#check-id'),
      showManufacturer: document.querySelector('#check-mfr'),
      showMaterial: document.querySelector('#check-mat'),
      showColor: document.querySelector('#check-color'),
      showColorSwatch: document.querySelector('#check-color-swatch'),
      showColorHex: document.querySelector('#check-color-hex'),
    })
  })

  it('reports the id of a missing required control', () => {
    renderPrintPageControls()
    document.querySelector('#btn-export-aml')?.remove()

    expect(() => getLabelOutputControls()).toThrow(
      'Missing label print control: #btn-export-aml',
    )
  })

  it('collapses the application sidebar at the current print-page breakpoint', () => {
    renderPrintPageControls()
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 1000,
    })

    const cleanup = bindPrintPageSidebarCollapse()

    expect(document.documentElement.classList.contains('sidebar-collapsed'))
      .toBe(true)
    expect(document.querySelector('#fm-page')?.classList.contains('collapsed'))
      .toBe(true)
    expect(localStorage.getItem('sidebar-collapsed')).toBe('true')

    cleanup()
  })
})

describe('shared single-label print-page behavior', () => {
  it('restores and persists preview zoom through the existing zoom controls', () => {
    renderPrintPageControls()
    localStorage.setItem('test-label-zoom', '135')
    const onChange = vi.fn()
    const previewRoot = document.querySelector<HTMLElement>(
      '.preview-scroll-area',
    )!

    const zoom = bindLabelPreviewZoom({
      storageKey: 'test-label-zoom',
      previewRoot,
      min: 50,
      onChange,
      getTranslation: (_key, fallback) => fallback,
    })

    expect(zoom.getZoom()).toBe(135)
    expect(document.querySelector('#preview-zoom-slider'))
      .toHaveProperty('value', '135')
    expect(document.querySelector('#preview-zoom-label')?.textContent)
      .toBe('135%')
    expect(onChange).toHaveBeenCalledOnce()

    document.querySelector<HTMLButtonElement>('#preview-zoom-in')?.click()

    expect(zoom.getZoom()).toBe(145)
    expect(localStorage.getItem('test-label-zoom')).toBe('145')
    expect(onChange).toHaveBeenCalledTimes(2)
  })

  it('supports route-owned preview zoom storage without replacing its settings payload', () => {
    renderPrintPageControls()
    localStorage.setItem('batch-label-settings', JSON.stringify({
      width: '60',
      zoom: '135',
    }))
    const previewRoot = document.querySelector<HTMLElement>(
      '.preview-scroll-area',
    )!

    const zoom = bindLabelPreviewZoom({
      storageKey: 'batch-label-settings',
      previewRoot,
      min: 50,
      readStoredZoom: () => Number(JSON.parse(
        localStorage.getItem('batch-label-settings')!,
      ).zoom),
      writeStoredZoom: value => {
        const settings = JSON.parse(
          localStorage.getItem('batch-label-settings')!,
        )
        settings.zoom = String(value)
        localStorage.setItem('batch-label-settings', JSON.stringify(settings))
      },
      onChange: () => undefined,
    })

    expect(zoom.getZoom()).toBe(135)
    document.querySelector<HTMLButtonElement>('#preview-zoom-in')?.click()
    expect(JSON.parse(localStorage.getItem('batch-label-settings')!))
      .toEqual({ width: '60', zoom: '145' })
  })

  it('stores preview zoom inside an existing versioned settings payload', () => {
    renderPrintPageControls()
    const storageKey = 'batch-settings'
    localStorage.setItem(storageKey, JSON.stringify({
      _v: 2,
      zoom: '135',
      extraFields: { density: true },
    }))
    const previewRoot = document.querySelector<HTMLElement>(
      '.preview-scroll-area',
    )!
    const bindNestedZoom = bindLabelPreviewZoom as unknown as (
      options: Parameters<typeof bindLabelPreviewZoom>[0] & { settingsVersion: number },
    ) => ReturnType<typeof bindLabelPreviewZoom>

    const zoom = bindNestedZoom({
      storageKey,
      settingsVersion: 2,
      previewRoot,
      onChange: () => undefined,
    })
    expect(zoom.getZoom()).toBe(135)

    const slider = document.querySelector<HTMLInputElement>('#preview-zoom-slider')!
    slider.value = '145'
    slider.dispatchEvent(new Event('input'))

    expect(JSON.parse(localStorage.getItem(storageKey)!)).toEqual({
      _v: 2,
      zoom: '145',
      extraFields: { density: true },
    })
  })

  it('rejects stale versioned zoom before current settings can persist it', () => {
    renderPrintPageControls()
    const storageKey = 'versioned-batch-label-settings'
    localStorage.setItem(storageKey, JSON.stringify({
      _v: 1,
      width: '72',
      zoom: '135',
    }))
    const settings = readVersionedLabelSettings<{ zoom?: string }>(
      storageKey,
      2,
    )
    const previewRoot = document.querySelector<HTMLElement>(
      '.preview-scroll-area',
    )!

    const zoom = bindLabelPreviewZoom({
      storageKey,
      previewRoot,
      min: 50,
      readStoredZoom: () => settings?.zoom === undefined
        ? null
        : Number(settings.zoom),
      writeStoredZoom: () => undefined,
      onChange: () => undefined,
    })

    expect(zoom.getZoom()).toBe(100)
    expect(localStorage.getItem(storageKey)).toBe('')

    localStorage.setItem(storageKey, JSON.stringify({
      _v: 2,
      zoom: String(zoom.getZoom()),
    }))
    expect(JSON.parse(localStorage.getItem(storageKey)!))
      .toEqual({ _v: 2, zoom: '100' })
  })

  it.each([
    JSON.stringify({ _v: 'invalid', zoom: '135' }),
    JSON.stringify(['not', 'settings']),
    JSON.stringify('not settings'),
  ])('rejects malformed versioned settings payload %s', raw => {
    localStorage.setItem('malformed-label-settings', raw)

    expect(readVersionedLabelSettings('malformed-label-settings', 2)).toBeNull()
    expect(localStorage.getItem('malformed-label-settings')).toBe('')
  })

  it('binds setting changes, live numeric input, reset, and cleanup', () => {
    renderPrintPageControls()
    const controls = getLabelSettingsControls()
    const onChange = vi.fn()
    const onReset = vi.fn()
    const resetButton = document.createElement('button')
    const cleanup = bindLabelSettingsEvents({
      controls,
      resetButton,
      onChange,
      onReset,
    })

    controls.showLogo.dispatchEvent(new Event('change'))
    controls.width.dispatchEvent(new Event('input'))
    resetButton.click()

    expect(onChange).toHaveBeenCalledTimes(2)
    expect(onReset).toHaveBeenCalledOnce()

    cleanup()
    controls.width.dispatchEvent(new Event('change'))
    resetButton.click()
    expect(onChange).toHaveBeenCalledTimes(2)
    expect(onReset).toHaveBeenCalledOnce()
  })

  it('captures and restores standard label control values', () => {
    renderPrintPageControls()
    const controls = getLabelSettingsControls()
    controls.width.value = '72'
    controls.height.value = '36'
    controls.fontSize.value = '80'
    controls.qrSize.value = '16.5'
    controls.showLogo.checked = false
    controls.showQr.checked = true
    controls.showId.checked = false
    controls.showManufacturer.checked = true
    controls.showMaterial.checked = false
    controls.showColor.checked = true
    controls.showColorSwatch.checked = false
    controls.showColorHex.checked = true
    const density = document.createElement('input')
    density.type = 'checkbox'
    density.checked = true
    const extraFields = { density }
    const settings = captureLabelSettings(controls, extraFields)
    controls.width.value = '20'
    controls.showLogo.checked = true
    density.checked = false
    restoreLabelSettings(controls, settings, extraFields)

    expect(settings).toEqual({
      width: '72',
      height: '36',
      fontSize: '80',
      qrSize: '16.5',
      showLogo: false,
      showQR: true,
      showID: false,
      showMfr: true,
      showMat: false,
      showColor: true,
      showColorSwatch: false,
      showColorHex: true,
      extraFields: { density: true },
    })
    expect(controls.width.value).toBe('72')
    expect(controls.showLogo.checked).toBe(false)
    expect(density.checked).toBe(true)
  })

  it('keeps batch input defaults when a stored value is empty', () => {
    renderPrintPageControls()
    const controls = getLabelSettingsControls()
    controls.width.value = '60'
    restoreLabelSettings(
      controls,
      { width: '' },
      undefined,
      { requireInputValues: true },
    )

    expect(controls.width.value).toBe('60')
  })

  it('derives standard renderer settings and normalizes single-route inputs', () => {
    renderPrintPageControls()
    const controls = getLabelSettingsControls()
    controls.width.value = '500'
    controls.height.value = '36'
    controls.fontSize.value = '80'
    controls.qrSize.value = '16.5'
    controls.showLogo.checked = false
    controls.showQr.checked = true
    controls.showId.checked = false
    controls.showManufacturer.checked = true
    controls.showMaterial.checked = false
    controls.showColor.checked = true
    controls.showColorSwatch.checked = false
    controls.showColorHex.checked = true
    expect(getStandardLabelSettings(controls, { normalizeInputs: true })).toEqual({
      widthMm: 200,
      heightMm: 36,
      fontScale: 0.8,
      qrSizeMm: 16.5,
      showLogo: false,
      showQR: true,
      showID: false,
      showManufacturer: true,
      showMaterial: false,
      showColor: true,
      showColorSwatch: false,
      showColorHex: true,
    })
    expect(controls.width.value).toBe('200')
  })

  it('resets all standard label controls to their shared defaults', () => {
    renderPrintPageControls()
    const controls = getLabelSettingsControls()
    controls.width.value = '72'
    controls.height.value = '36'
    controls.fontSize.value = '80'
    controls.qrSize.value = '16.5'
    Object.values(controls).forEach(control => {
      if (control.type === 'checkbox') control.checked = false
    })
    const density = document.createElement('input')
    density.type = 'checkbox'
    density.checked = true
    resetLabelSettings(controls, { density })

    expect({
      width: controls.width.value,
      height: controls.height.value,
      fontSize: controls.fontSize.value,
      qrSize: controls.qrSize.value,
      extraFieldChecked: density.checked,
      checked: Object.values(controls)
        .filter(control => control.type === 'checkbox')
        .every(control => control.checked),
    }).toEqual({
      width: '60',
      height: '40',
      fontSize: '100',
      qrSize: '18',
      extraFieldChecked: false,
      checked: true,
    })
  })

  it('appends a scoped settings checkbox and wires its change behavior', () => {
    document.body.innerHTML = `
      <label class="fm-checkbox-group" data-astro-cid-print></label>
      <div id="extra-fields"></div>
    `
    const container = document.querySelector<HTMLElement>('#extra-fields')!
    const onChange = vi.fn()
    const checkbox = appendLabelSettingsCheckbox({
      container,
      id: 'check-density',
      label: 'Density',
      checked: true,
      onChange,
    })
    checkbox.dispatchEvent(new Event('change'))

    expect(container.innerHTML).toBe(
      '<label class="fm-checkbox-group" data-astro-cid-print=""><input type="checkbox" id="check-density" data-astro-cid-print=""><span data-astro-cid-print="">Density</span></label>',
    )
    expect(checkbox.checked).toBe(true)
    expect(onChange).toHaveBeenCalledOnce()
  })

  it('switches between individual zoom and label-paper preview behavior', () => {
    renderPrintPageControls()
    const previewRoot = document.querySelector<HTMLElement>(
      '.preview-scroll-area',
    )!
    const label = document.querySelector<HTMLElement>('#label-preview')!
    const outputControls = getLabelOutputControls()
    let outputMode: 'individual' | 'sheet' = 'individual'
    const sheetControls = {
      getOutputMode: () => outputMode,
      getSettings: () => ({
        paperSize: 'a4',
        customWidthMm: 210,
        customHeightMm: 297,
        rows: 1,
        columns: 1,
        marginTopMm: 0,
        marginRightMm: 0,
        marginBottomMm: 0,
        marginLeftMm: 0,
        gapHorizontalMm: 0,
        gapVerticalMm: 0,
        skipCells: 0,
        copies: 1,
        showGrid: false,
        printGrid: false,
        fitToCell: false,
      }),
      setOutputMode: mode => {
        outputMode = mode
      },
    } satisfies LabelSheetControls
    const applyIndividualZoom = vi.fn()
    const sync = bindLabelOutputPreview({
      previewRoot,
      sheetControls,
      outputControls,
      getSourceElements: () => [label],
      getDimensions: () => ({ widthMm: 60, heightMm: 40 }),
      getZoom: () => 125,
      applyIndividualZoom,
    })

    sync()
    expect(applyIndividualZoom).toHaveBeenCalledWith(125)
    expect(outputControls.pngButton.disabled).toBe(false)

    outputMode = 'sheet'
    sync()
    expect(previewRoot.classList.contains('is-label-sheet-mode')).toBe(true)
    expect(previewRoot.querySelector<HTMLElement>('.label-sheet-page')?.style.transform)
      .toBe('scale(1.25)')
    expect(outputControls.pngButton.disabled).toBe(true)
    expect(outputControls.amlButton.disabled).toBe(true)
  })
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

  it('locks preview-mutating controls until an output operation completes', async () => {
    let finishPrepare!: () => void
    const pendingPrepare = new Promise<void>(resolve => {
      finishPrepare = resolve
    })
    const { controls, capture } = bindCollectionOutputs([1], {
      prepare: vi.fn(() => pendingPrepare),
    })
    document.body.insertAdjacentHTML('beforeend', `
      <aside class="print-sidebar">
        <button id="tab-designer">Designer</button>
        <select id="output-mode"><option>Individual</option></select>
        <textarea id="designer-template"></textarea>
      </aside>
      <div class="preview-zoom-bar">
        <button id="zoom-in">Zoom in</button>
        <input id="zoom-slider" type="range">
      </div>
    `)
    const mutationControls = [
      '#tab-designer',
      '#output-mode',
      '#designer-template',
      '#zoom-in',
      '#zoom-slider',
    ].map(selector => document.querySelector<HTMLElement & { disabled: boolean }>(selector)!)

    controls.pngButton.click()
    await Promise.resolve()

    expect(mutationControls.every(control => control.disabled)).toBe(true)
    expect(capture).not.toHaveBeenCalled()

    finishPrepare()
    await vi.waitFor(() => expect(capture).toHaveBeenCalledOnce())
    await vi.waitFor(() => {
      expect(mutationControls.every(control => !control.disabled)).toBe(true)
    })
  })

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

    bindBatchCollectionOutputs({
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

    bindBatchCollectionOutputs({
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

    bindBatchCollectionOutputs({
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

    bindSingleCollectionOutputs({
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

      bindBatchCollectionOutputs({
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

      bindBatchCollectionOutputs({
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

    bindSingleCollectionOutputs({
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

    bindBatchCollectionOutputs({
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

describe('collection output binding', () => {
  it('downloads one PNG and AML directly', async () => {
    const clicks: Array<{ name: string; href: string }> = []
    vi.spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function(this: HTMLAnchorElement) {
        clicks.push({ name: this.download, href: this.href })
      })
    vi.mocked(URL.createObjectURL).mockReturnValue('blob:label-aml')
    const { controls } = bindCollectionOutputs([1])

    controls.pngButton.click()
    await vi.waitFor(() => {
      expect(clicks).toEqual([{
        name: 'label-1.png',
        href: 'data:image/png;base64,aXRlbS01',
      }])
    })

    controls.amlButton.click()
    await vi.waitFor(() => {
      expect(clicks).toEqual([
        {
          name: 'label-1.png',
          href: 'data:image/png;base64,aXRlbS01',
        },
        { name: 'label-1.aml', href: 'blob:label-aml' },
      ])
    })
  })

  it.each([
    { action: 'pngButton', archiveName: 'labels.zip' },
    { action: 'amlButton', archiveName: 'labels-aml.zip' },
  ] as const)('archives two $action outputs', async ({ action, archiveName }) => {
    let archiveBlob: Blob | undefined
    vi.mocked(URL.createObjectURL).mockImplementation(value => {
      archiveBlob = value as Blob
      return 'blob:label-archive'
    })
    const downloads: string[] = []
    vi.spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function(this: HTMLAnchorElement) {
        downloads.push(this.download)
      })
    const { controls } = bindCollectionOutputs([1, 2])

    controls[action].click()

    await vi.waitFor(() => expect(downloads).toEqual([archiveName]))
    const zip = await JSZip.loadAsync(await archiveBlob!.arrayBuffer())
    const extension = action === 'pngButton' ? 'png' : 'aml'
    expect(Object.keys(zip.files)).toEqual([
      `label-1.${extension}`,
      `label-2.${extension}`,
    ])
  })

  it('uses collection indexes for duplicate item archive names', async () => {
    let archiveBlob: Blob | undefined
    vi.mocked(URL.createObjectURL).mockImplementation(value => {
      archiveBlob = value as Blob
      return 'blob:duplicate-item-archive'
    })
    vi.spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined)
    const { controls } = bindCollectionOutputs([1, 1], {
      pngName: (_item, index) => `label-${index + 1}.png`,
    })

    controls.pngButton.click()

    await vi.waitFor(() => expect(archiveBlob).toBeDefined())
    const zip = await JSZip.loadAsync(await archiveBlob!.arrayBuffer())
    expect(Object.keys(zip.files)).toEqual(['label-1.png', 'label-2.png'])
  })

  it('archives a surviving PNG when partial collection capture is allowed', async () => {
    let archiveBlob: Blob | undefined
    vi.mocked(URL.createObjectURL).mockImplementation(value => {
      archiveBlob = value as Blob
      return 'blob:partial-label-archive'
    })
    const downloads: string[] = []
    vi.spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function(this: HTMLAnchorElement) {
        downloads.push(this.download)
      })
    const { controls } = bindCollectionOutputs([1, 2], {
      allowPartialPng: true,
      capture: async item => {
        if (item === 1) throw new Error('capture failed')
        return 'data:image/png;base64,c3Vydml2b3I='
      },
    })

    controls.pngButton.click()

    await vi.waitFor(() => expect(downloads).toEqual(['labels.zip']))
    const zip = await JSZip.loadAsync(await archiveBlob!.arrayBuffer())
    expect(Object.keys(zip.files)).toEqual(['label-2.png'])
  })

  it('reports the translated PNG failure when every capture fails', async () => {
    const alert = vi.spyOn(window, 'alert')
      .mockImplementation(() => undefined)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const download = vi.spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined)
    const { controls } = bindCollectionOutputs([1, 2], {
      allowPartialPng: true,
      capture: async () => {
        throw new Error('capture failed')
      },
    })

    controls.pngButton.click()

    await vi.waitFor(() => {
      expect(alert).toHaveBeenCalledWith('Translated PNG failure.')
    })
    expect(download).not.toHaveBeenCalled()
  })

  it('creates PDF pages in collection order', async () => {
    const pdf = makePdfDocument()
    const capturedPages: LabelPdfPage[][] = []
    const { controls } = bindCollectionOutputs([2, 1], {
      createPdf: async pages => {
        capturedPages.push(pages)
        return pdf
      },
    })

    controls.pdfButton.click()

    await vi.waitFor(() => expect(pdf.save).toHaveBeenCalledWith('labels.pdf'))
    expect(capturedPages).toEqual([[
      {
        dataUrl: 'data:image/png;base64,aXRlbS02',
        widthMm: 48,
        heightMm: 30,
      },
      {
        dataUrl: 'data:image/png;base64,aXRlbS01',
        widthMm: 48,
        heightMm: 30,
      },
    ]])
  })

  it('reports a translated PDF export failure when every partial batch capture fails', async () => {
    const alert = vi.spyOn(window, 'alert')
      .mockImplementation(() => undefined)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const download = vi.spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined)
    const open = vi.spyOn(window, 'open')
    const { controls } = bindCollectionOutputs([1, 2], {
      allowPartialPdf: true,
      capture: async () => {
        throw new Error('capture failed')
      },
      getTranslation: (key, fallback) =>
        key === 'labelPrint.pdfExportFailed'
          ? 'Translated PDF export failure.'
          : fallback,
    })

    controls.pdfButton.click()

    await vi.waitFor(() => {
      expect(alert).toHaveBeenCalledWith('Translated PDF export failure.')
    })
    expect(download).not.toHaveBeenCalled()
    expect(URL.createObjectURL).not.toHaveBeenCalled()
    expect(open).not.toHaveBeenCalled()
  })

  it('reports a translated temporary-PDF failure and closes its tab when every partial batch capture fails', async () => {
    const { popup, close, replace } = makePopup()
    vi.spyOn(window, 'open').mockReturnValue(popup)
    const alert = vi.spyOn(window, 'alert')
      .mockImplementation(() => undefined)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const download = vi.spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined)
    const { controls } = bindCollectionOutputs([1, 2], {
      allowPartialPdf: true,
      capture: async () => {
        throw new Error('capture failed')
      },
      getTranslation: (key, fallback) =>
        key === 'labelPrint.printPdfFailed'
          ? 'Translated temporary-PDF failure.'
          : fallback,
    })
    controls.printPdfCheckbox.checked = true

    controls.printButton.click()

    await vi.waitFor(() => {
      expect(alert).toHaveBeenCalledWith('Translated temporary-PDF failure.')
    })
    expect(close).toHaveBeenCalledOnce()
    expect(replace).not.toHaveBeenCalled()
    expect(download).not.toHaveBeenCalled()
    expect(URL.createObjectURL).not.toHaveBeenCalled()
  })

  it('gets individual browser-print pages after preparing the collection', async () => {
    const calls: string[] = []
    const page = document.createElement('article')
    const { controls } = bindCollectionOutputs([1], {
      prepare: async () => {
        calls.push('prepare')
      },
      getIndividualPages: () => {
        calls.push('pages')
        return [page]
      },
    })

    controls.printButton.click()

    await vi.waitFor(() => expect(printLabelBrowserJob).toHaveBeenCalledOnce())
    expect(calls).toEqual(['prepare', 'pages'])
    expect(vi.mocked(printLabelBrowserJob).mock.calls[0]?.[0].pages)
      .toEqual([page])
  })

  it('uses the shared PDF action when temporary-PDF printing is checked', async () => {
    const pdf = makePdfDocument()
    const { popup } = makePopup()
    vi.spyOn(window, 'open').mockReturnValue(popup)
    const { controls } = bindCollectionOutputs([1], {
      createPdf: async () => pdf,
    })
    controls.printPdfCheckbox.checked = true

    controls.printButton.click()

    await vi.waitFor(() => expect(pdf.output).toHaveBeenCalledWith('blob'))
    expect(printLabelBrowserJob).not.toHaveBeenCalled()
  })

  it('preserves a live aria-disabled change when the coordinator releases controls', async () => {
    let resolveCapture!: (value: string) => void
    const { controls } = bindCollectionOutputs([1], {
      capture: () => new Promise(resolve => {
        resolveCapture = resolve
      }),
    })
    vi.spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined)

    controls.pngButton.click()
    await vi.waitFor(() => expect(controls.pngButton.disabled).toBe(true))
    controls.pngButton.setAttribute('aria-disabled', 'true')
    resolveCapture('data:image/png;base64,aXRlbS01')

    await vi.waitFor(() => expect(controls.pngButton.disabled).toBe(true))
  })
})
