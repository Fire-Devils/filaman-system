import {
  LABEL_EXPORT_PIXEL_RATIO,
  captureLabelElement,
  createLabelPagesPdf,
  type LabelPdfDocument,
  type LabelPdfPage,
} from './label-export'
import {
  amlArchiveNameFromPngArchive,
  amlFilenameFromPng,
  buildLabelAml,
} from './label-aml'
import {
  downloadLabelFiles,
  type LabelDownloadFile,
} from './label-file-export'
import {
  cleanupLabelBrowserPrint,
  createLabelBrowserPrintJob,
  printLabelBrowserJob,
  type LabelBrowserPrintJob,
} from './label-browser-print'
import type { LabelSheetControls } from './label-sheet'
import { bindFixedPreviewToolbar } from './label-preview-dom'

export { LABEL_EXPORT_DPI, LABEL_EXPORT_PIXEL_RATIO } from './label-export'

export const LABEL_PRINT_PDF_MODE_KEY = 'filaman-label-print-pdf-v1'

export interface PdfOutputActionsOptions {
  pdfButton: HTMLButtonElement
  createPdf: () => Promise<LabelPdfDocument | null>
  getFilename: () => string
  getTranslation: (key: string, fallback: string) => string
  coordinator?: LabelOutputCoordinator
}

interface LabelOutputCoordinator {
  run(
    progressText: string,
    action: () => Promise<void>,
    prepare?: () => boolean,
  ): Promise<void>
}

function createLabelOutputCoordinator(
  buttons: HTMLButtonElement[],
): LabelOutputCoordinator {
  let operationRunning = false

  return {
    async run(progressText, action, prepare) {
      if (operationRunning) return
      operationRunning = true
      let originalStates: Array<{
        button: HTMLButtonElement
        disabled: boolean
        ariaDisabled: string | null
        text: string | null
      }> | null = null

      try {
        if (prepare && !prepare()) return
        originalStates = buttons.map(button => ({
          button,
          disabled: button.disabled,
          ariaDisabled: button.getAttribute('aria-disabled'),
          text: button.textContent,
        }))
        buttons.forEach(button => {
          button.disabled = true
          button.textContent = progressText
        })
        await action()
      } finally {
        originalStates?.forEach(({
          button,
          disabled,
          ariaDisabled,
          text,
        }) => {
          const currentAriaDisabled = button.getAttribute('aria-disabled')
          button.disabled = currentAriaDisabled === ariaDisabled
            ? disabled
            : currentAriaDisabled === 'true'
          button.textContent = text
        })
        operationRunning = false
      }
    },
  }
}

const activePrintPdfUrls = new Set<string>()
let printPdfCleanupBound = false

function bindPrintPdfCleanup() {
  if (printPdfCleanupBound) return
  printPdfCleanupBound = true
  window.addEventListener('pagehide', releasePrintPdfUrls)
}

export function releasePrintPdfUrls() {
  activePrintPdfUrls.forEach(url => URL.revokeObjectURL(url))
  activePrintPdfUrls.clear()
}

function showPreparingPrintPdf(
  popup: Window,
  message: string,
) {
  popup.document.title = message
  popup.document.body.replaceChildren()
  popup.document.body.style.cssText =
    'font-family:system-ui,sans-serif;padding:2rem;color:#222'
  const status = popup.document.createElement('p')
  status.textContent = message
  popup.document.body.appendChild(status)
}

export function bindPdfOutputActions(
  options: PdfOutputActionsOptions,
) {
  const coordinator = options.coordinator ??
    createLabelOutputCoordinator([options.pdfButton])

  const execute = async (
    target: 'download' | 'print',
  ): Promise<void> => {
    let popup: Window | null = null
    const progressText = options.getTranslation(
      target === 'print'
        ? 'labelPrint.preparingPrintPdf'
        : 'labelPrint.exporting',
      target === 'print'
        ? 'Preparing print PDF…'
        : 'Exporting...',
    )

    await coordinator.run(
      progressText,
      async () => {
        let blobUrl: string | null = null
        try {
          const pdf = await options.createPdf()
          if (!pdf) {
            popup?.close()
            return
          }

          if (target === 'download') {
            pdf.save(options.getFilename())
            return
          }

          blobUrl = URL.createObjectURL(pdf.output('blob'))
          activePrintPdfUrls.add(blobUrl)
          bindPrintPdfCleanup()
          popup!.location.replace(blobUrl)
        } catch (error) {
          if (blobUrl) {
            activePrintPdfUrls.delete(blobUrl)
            URL.revokeObjectURL(blobUrl)
          }
          popup?.close()
          window.alert(
            options.getTranslation(
              target === 'print'
                ? 'labelPrint.printPdfFailed'
                : 'labelPrint.pdfExportFailed',
              target === 'print'
                ? 'Print PDF generation failed.'
                : 'PDF export failed.',
            ),
          )
          console.error(
            target === 'print'
              ? 'Failed to create print PDF:'
              : 'Failed to export label PDF:',
            error,
          )
        }
      },
      target === 'print'
        ? () => {
            popup = window.open('', '_blank')
            if (!popup) {
              window.alert(
                options.getTranslation(
                  'labelPrint.printPopupBlocked',
                  'Allow pop-ups to open the print PDF.',
                ),
              )
              return false
            }
            showPreparingPrintPdf(
              popup,
              options.getTranslation(
                'labelPrint.preparingPrintPdf',
                'Preparing print PDF…',
              ),
            )
            return true
          }
        : undefined,
    )
  }

  const download = () => execute('download')
  const print = () => execute('print')

  options.pdfButton.addEventListener('click', () => {
    void download()
  })

  return { download, print }
}

interface SelectablePrintActionOptions {
  printButton: HTMLButtonElement
  printPdfCheckbox: HTMLInputElement
  coordinator: LabelOutputCoordinator
  createBrowserPrintJob: () => Promise<LabelBrowserPrintJob>
  printPdf: () => Promise<void>
  getTranslation: (key: string, fallback: string) => string
}

function bindSelectablePrintAction(
  options: SelectablePrintActionOptions,
) {
  const getPdfMode = bindPrintPdfPreference(options.printPdfCheckbox)
  options.printButton.addEventListener('click', () => {
    if (getPdfMode()) {
      void options.printPdf()
      return
    }

    void options.coordinator.run(
      options.getTranslation(
        'labelPrint.preparingBrowserPrint',
        'Preparing browser print…',
      ),
      async () => {
        try {
          await printLabelBrowserJob(
            await options.createBrowserPrintJob(),
          )
        } catch (error) {
          cleanupLabelBrowserPrint()
          window.alert(options.getTranslation(
            'labelPrint.browserPrintFailed',
            'Browser printing failed.',
          ))
          console.error('Failed to prepare browser label print:', error)
        }
      },
    )
  })
}

const STORAGE_SOFT_LIMIT_BYTES = 4_500_000

export function safeSetLocalStorage(key: string, value: string) {
  if (value.length > STORAGE_SOFT_LIMIT_BYTES) {
    console.warn(`Skipped persisting ${key}: payload too large`)
    return false
  }
  try {
    localStorage.setItem(key, value)
    return true
  } catch (error) {
    console.warn(`Failed to persist ${key}`, error)
    return false
  }
}

export function readStorageValue(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

export function writeStorageValue(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Print preview still works when storage is blocked.
  }
}

export function bindPrintPdfPreference(checkbox: HTMLInputElement) {
  checkbox.checked = readStorageValue(LABEL_PRINT_PDF_MODE_KEY) === 'true'
  checkbox.addEventListener('change', () => {
    writeStorageValue(
      LABEL_PRINT_PDF_MODE_KEY,
      String(checkbox.checked),
    )
  })
  return () => checkbox.checked
}

export function removeStorageValue(key: string) {
  try {
    localStorage.removeItem(key)
  } catch {
    // Ignore blocked storage.
  }
}

export function parseJsonOrNull<T = unknown>(raw: string | null): T | null {
  if (!raw) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

function clampNumber(value: number, min: number, max: number, fallback: number) {
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

export function clampInputValue(input: HTMLInputElement, min: number, max: number, fallback: number, decimals = 2) {
  const next = clampNumber(Number(input.value), min, max, fallback)
  const normalized = Number(next.toFixed(decimals))
  input.value = String(normalized)
  return normalized
}

interface PreviewZoomControlsOptions {
  zoomInput: HTMLInputElement
  slider?: HTMLInputElement | null
  label?: HTMLElement | null
  zoomOutBtn?: HTMLElement | null
  zoomInBtn?: HTMLElement | null
  zoomResetBtn?: HTMLElement | null
  min?: number
  max?: number
  step?: number
  buttonStep?: number
  defaultZoom?: number
  getTranslation?: (key: string, fallback: string) => string
  onChange: () => void
}

function normalizeZoom(value: number, min: number, max: number, step: number, fallback: number) {
  const clamped = clampNumber(value, min, max, fallback)
  return Math.min(max, Math.max(min, Math.round(clamped / step) * step))
}

export function bindPreviewZoomControls(options: PreviewZoomControlsOptions) {
  const min = options.min ?? 25
  const max = options.max ?? 300
  const step = options.step ?? 5
  const buttonStep = options.buttonStep ?? 10
  const defaultZoom = options.defaultZoom ?? 100
  const translate = options.getTranslation

  const getZoom = () => normalizeZoom(Number(options.zoomInput.value), min, max, step, defaultZoom)

  const sync = () => {
    const zoom = getZoom()
    options.zoomInput.value = String(zoom)
    if (options.slider) options.slider.value = String(zoom)
    if (options.label) options.label.textContent = `${zoom}%`
  }

  const applyZoom = (nextZoom: number) => {
    options.zoomInput.value = String(normalizeZoom(nextZoom, min, max, step, defaultZoom))
    sync()
    options.onChange()
  }

  const setButtonLabel = (button: HTMLElement | null | undefined, key: string, fallback: string) => {
    if (!button || !translate) return
    const label = translate(key, fallback)
    button.title = label
    button.setAttribute('aria-label', label)
  }

  setButtonLabel(options.zoomOutBtn, 'labelPrint.zoomOut', 'Zoom out')
  setButtonLabel(options.zoomInBtn, 'labelPrint.zoomIn', 'Zoom in')
  setButtonLabel(options.zoomResetBtn, 'labelPrint.zoomReset', 'Reset zoom')

  options.slider?.addEventListener('input', event => {
    applyZoom(Number((event.target as HTMLInputElement).value))
  })
  options.zoomOutBtn?.addEventListener('click', () => applyZoom(getZoom() - buttonStep))
  options.zoomInBtn?.addEventListener('click', () => applyZoom(getZoom() + buttonStep))
  options.zoomResetBtn?.addEventListener('click', () => applyZoom(defaultZoom))

  sync()

  return { getZoom, applyZoom, sync }
}

export function applyBatchLabelPreviewZoom(previewRoot: HTMLElement, zoomPercent: number) {
  const zoom = normalizeZoom(Number(zoomPercent), 25, 300, 5, 100) / 100
  bindFixedPreviewToolbar({ previewRoot })
  const labels = Array.from(previewRoot.querySelectorAll<HTMLElement>(':scope > .label-wrapper')).map(wrapper => {
    const label = wrapper.querySelector<HTMLElement>(':scope > .label-preview')
    return label ? { wrapper, label, width: label.offsetWidth, height: label.offsetHeight } : null
  }).filter((entry): entry is { wrapper: HTMLElement; label: HTMLElement; width: number; height: number } => !!entry)

  labels.forEach(({ wrapper, label, width, height }) => {
    label.style.zoom = '1'
    label.style.transform = `scale(${zoom})`
    label.style.transformOrigin = 'top left'
    wrapper.style.width = `${width * zoom}px`
    wrapper.style.height = `${height * zoom}px`
    wrapper.style.flex = '0 0 auto'
    wrapper.style.overflow = 'visible'
  })
}

export type PrintDesignerTab = 'print' | 'designer'

interface PrintDesignerTabsOptions {
  buttons: Iterable<HTMLButtonElement>
  printPanel: HTMLElement
  designerPanel: HTMLElement
  resetButton?: HTMLElement | null
  sidebar?: HTMLElement | null
  storageKey: string
  initialTab?: PrintDesignerTab
  onChange: (tab: PrintDesignerTab) => void
}

export function readPrintDesignerTab(storageKey: string, fallback: PrintDesignerTab = 'print'): PrintDesignerTab {
  return readStorageValue(storageKey) === 'designer' ? 'designer' : fallback
}

export function bindPrintDesignerTabs(options: PrintDesignerTabsOptions) {
  let activeTab = options.initialTab ?? readPrintDesignerTab(options.storageKey)
  const buttons = Array.from(options.buttons)

  const activate = (tab: PrintDesignerTab) => {
    activeTab = tab
    buttons.forEach(button => button.classList.toggle('active', button.dataset.tab === tab))
    options.printPanel.style.display = tab === 'print' ? '' : 'none'
    options.designerPanel.style.display = tab === 'designer' ? '' : 'none'
    if (options.resetButton) options.resetButton.style.display = tab === 'print' ? '' : 'none'
    options.sidebar?.classList.toggle('sidebar-wide', tab === 'designer')
    writeStorageValue(options.storageKey, tab)
    options.onChange(tab)
  }

  buttons.forEach(button => {
    button.addEventListener('click', () => activate(button.dataset.tab === 'designer' ? 'designer' : 'print'))
  })

  return {
    activate,
    getActiveTab: () => activeTab,
  }
}

export function buildLabelExportBaseName(parts: unknown[], fallback: string) {
  const value = parts
    .filter(Boolean)
    .join(' - ')
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/\.+$/g, '')
  return value || fallback
}

export type LabelEntityType = 'spool' | 'filament'
export type LabelEntityId = string | number

export interface LabelPrintEntityAdapter<T, TStandardData = unknown, TDesignerData = unknown> {
  entityType: LabelEntityType
  entityPath: 'spools' | 'filaments'
  getId: (entity: T) => LabelEntityId | null | undefined
  getLogoManufacturerId: (entity: T) => number | null
  buildStandardData: (entity: T) => TStandardData
  buildDesignerData: (entity: T) => TDesignerData
  singlePngName: (entity: T) => string
  zipName: () => string
  zipEntryName: (entity: T) => string
  pdfName: () => string
  missingIdMessage: string
}

export function getLabelElementId(entityId: LabelEntityId) {
  return `label-${entityId}`
}

export function makeBatchLabelHtml(entityId: LabelEntityId, labelHtml: string) {
  return `<div class="label-wrapper" id="wrapper-${entityId}"><div class="label-preview" id="${getLabelElementId(entityId)}">
      ${labelHtml}
    </div></div>`
}

export function findBatchLabelElement<T>(adapter: LabelPrintEntityAdapter<T>, entity: T) {
  const entityId = adapter.getId(entity)
  if (entityId == null) return null
  const element = document.getElementById(getLabelElementId(entityId))
  return element instanceof HTMLElement ? element : null
}

function requireLabelEntityId<T>(adapter: LabelPrintEntityAdapter<T>, entity: T) {
  const entityId = adapter.getId(entity)
  if (entityId == null) throw new Error(adapter.missingIdMessage)
  return entityId
}

export function getCachedEntityLogoUrl<T>(
  adapter: LabelPrintEntityAdapter<T>,
  logoCache: Record<number, string | null>,
  entity: T,
) {
  const manufacturerId = adapter.getLogoManufacturerId(entity)
  return manufacturerId ? logoCache[manufacturerId] ?? null : null
}

export async function prefetchEntityLogos<T>(
  entities: T[],
  adapter: LabelPrintEntityAdapter<T>,
  loadLogo: (manufacturerId: number) => Promise<string | null>,
) {
  const manufacturerIds = [...new Set(
    entities.map(entity => adapter.getLogoManufacturerId(entity)).filter((id): id is number => !!id),
  )]
  await Promise.all(manufacturerIds.map(id => loadLogo(id)))
}

export async function captureBatchLabel<T>(
  adapter: LabelPrintEntityAdapter<T>,
  entity: T,
  pixelRatio = LABEL_EXPORT_PIXEL_RATIO,
) {
  const elementId = getLabelElementId(requireLabelEntityId(adapter, entity))
  const element = document.getElementById(elementId)
  if (!(element instanceof HTMLElement)) {
    throw new Error(`Cannot capture label: element ${elementId} was not found`)
  }
  return captureLabelElement(element, { pixelRatio, resetZoom: true, resetTransform: true })
}

export type LabelPdfFactoryOverride = (
  pages: LabelPdfPage[],
  defaultCreate: () => Promise<LabelPdfDocument | null>,
) => Promise<LabelPdfDocument | null>

interface BrowserPrintBinding {
  previewRoot: HTMLElement
  sheetControls: LabelSheetControls
  getIndividualPages?: () => HTMLElement[]
}

function buildBrowserPrintJob(
  binding: BrowserPrintBinding,
  individualPages: HTMLElement[],
  individualDimensions: { widthMm: number; heightMm: number },
) {
  return createLabelBrowserPrintJob({
    outputMode: binding.sheetControls.getOutputMode(),
    previewRoot: binding.previewRoot,
    individualPages,
    individualDimensions,
    sheetSettings: binding.sheetControls.getSettings(),
  })
}

async function collectCapturedFiles<T, TResult>(
  entities: T[],
  capture: (entity: T) => Promise<string>,
  build: (entity: T, index: number, pngDataUrl: string) => TResult,
  skipCaptureErrors: boolean,
  throwWhenAllCapturesFail = true,
) {
  const files: TResult[] = []
  const canSkipCaptureError = skipCaptureErrors && entities.length > 1
  let firstCaptureError: unknown
  for (const [index, entity] of entities.entries()) {
    let pngDataUrl: string
    try {
      pngDataUrl = await capture(entity)
    } catch (error) {
      if (!canSkipCaptureError) throw error
      firstCaptureError ??= error
      continue
    }
    files.push(build(entity, index, pngDataUrl))
  }
  if (files.length === 0 && firstCaptureError && throwWhenAllCapturesFail) {
    throw firstCaptureError
  }
  return files
}

function buildPngDownloadFile(
  name: string,
  pngDataUrl: string,
): LabelDownloadFile {
  return {
    name,
    contents: pngDataUrl.split(',')[1] ?? '',
    mimeType: 'image/png',
    directUrl: pngDataUrl,
    zipBase64: true,
  }
}

function buildAmlDownloadFile(
  pngName: string,
  pngDataUrl: string,
  dimensions: { widthMm: number; heightMm: number },
): LabelDownloadFile {
  const name = amlFilenameFromPng(pngName)
  return {
    name,
    contents: buildLabelAml({
      name: name.replace(/\.aml$/i, ''),
      widthMm: dimensions.widthMm,
      heightMm: dimensions.heightMm,
      pngDataUrl,
    }),
    mimeType: 'application/xml',
  }
}

export interface LabelOutputControls {
  printButton: HTMLButtonElement
  printPdfCheckbox: HTMLInputElement
  pngButton: HTMLButtonElement
  amlButton: HTMLButtonElement
  pdfButton: HTMLButtonElement
}

export interface LabelOutputCollection<T> {
  getItems(): T[]
  prepare(): Promise<void>
  capture(item: T): Promise<string>
  getDimensions(): { widthMm: number; heightMm: number }
  browserPrint: BrowserPrintBinding & {
    getIndividualPages(): HTMLElement[]
  }
  pngName(item: T, index: number, total: number): string
  pngArchiveName(): string
  pdfName(): string
  allowPartialPng: boolean
  allowPartialPdf: boolean
}

export interface BindLabelOutputsOptions<T> {
  controls: LabelOutputControls
  collection: LabelOutputCollection<T>
  getTranslation(key: string, fallback: string): string
  createPdf?: LabelPdfFactoryOverride
}

export function bindLabelOutputs<T>(options: BindLabelOutputsOptions<T>) {
  const { controls, collection, getTranslation } = options
  const exportingText = () => getTranslation('labelPrint.exporting', 'Exporting...')
  const coordinator = createLabelOutputCoordinator([
    controls.printButton,
    controls.pngButton,
    controls.amlButton,
    controls.pdfButton,
  ])

  const exportFiles = async (kind: 'png' | 'aml') => {
    const button = kind === 'png' ? controls.pngButton : controls.amlButton
    if (button.getAttribute('aria-disabled') === 'true') return
    const items = collection.getItems()
    if (items.length === 0) return

    await coordinator.run(exportingText(), async () => {
      try {
        await collection.prepare()
        const dimensions = kind === 'aml' ? collection.getDimensions() : null
        const files = await collectCapturedFiles(
          items,
          collection.capture,
          (item, index, pngDataUrl) => {
            const pngName = collection.pngName(item, index, items.length)
            return kind === 'png'
              ? buildPngDownloadFile(pngName, pngDataUrl)
              : buildAmlDownloadFile(pngName, pngDataUrl, dimensions!)
          },
          collection.allowPartialPng,
        )
        await downloadLabelFiles(
          files,
          kind === 'png'
            ? collection.pngArchiveName()
            : amlArchiveNameFromPngArchive(collection.pngArchiveName()),
          { forceArchive: items.length > 1 },
        )
      } catch (error) {
        const isPng = kind === 'png'
        window.alert(getTranslation(
          isPng ? 'labelPrint.pngExportFailed' : 'labelPrint.amlExportFailed',
          isPng ? 'PNG export failed.' : 'AML export failed.',
        ))
        console.error(
          isPng ? 'Failed to export label PNG:' : 'Failed to export label AML:',
          error,
        )
      }
    })
  }

  controls.pngButton.addEventListener('click', () => {
    void exportFiles('png')
  })
  controls.amlButton.addEventListener('click', () => {
    void exportFiles('aml')
  })

  const collectPdfPages = async (): Promise<LabelPdfPage[]> => {
    const items = collection.getItems()
    if (items.length === 0) return []

    await collection.prepare()
    const dimensions = collection.getDimensions()
    return collectCapturedFiles(
      items,
      collection.capture,
      (_item, _index, dataUrl) => ({
        dataUrl,
        widthMm: dimensions.widthMm,
        heightMm: dimensions.heightMm,
      }),
      collection.allowPartialPdf,
    )
  }

  const createPdf = async () => {
    const pages = await collectPdfPages()
    if (pages.length === 0) return null
    const defaultCreate = () => createLabelPagesPdf(pages)
    return options.createPdf
      ? options.createPdf(pages, defaultCreate)
      : defaultCreate()
  }

  const pdfActions = bindPdfOutputActions({
    pdfButton: controls.pdfButton,
    createPdf,
    getFilename: collection.pdfName,
    getTranslation,
    coordinator,
  })
  bindSelectablePrintAction({
    printButton: controls.printButton,
    printPdfCheckbox: controls.printPdfCheckbox,
    coordinator,
    createBrowserPrintJob: async () => {
      await collection.prepare()
      return buildBrowserPrintJob(
        collection.browserPrint,
        collection.browserPrint.getIndividualPages(),
        collection.getDimensions(),
      )
    },
    printPdf: pdfActions.print,
    getTranslation,
  })
}

interface BatchLabelExportOptions<T> {
  entities: () => T[]
  activeTab: () => PrintDesignerTab
  printButton: HTMLButtonElement
  printPdfCheckbox: HTMLInputElement
  pngButton: HTMLButtonElement
  amlButton: HTMLButtonElement
  pdfButton: HTMLButtonElement
  getTranslation: (key: string, fallback: string) => string
  renderAll: (tab: PrintDesignerTab) => Promise<void>
  captureLabel: (entity: T) => Promise<string>
  getPdfDimensions: () => { widthMm: number; heightMm: number }
  singlePngName: (entity: T) => string
  zipName: () => string
  zipEntryName: (entity: T) => string
  pdfName: () => string
  browserPrint: BrowserPrintBinding & {
    getIndividualPages: () => HTMLElement[]
  }
  createPdf?: LabelPdfFactoryOverride
  skipCaptureErrorsInZip?: boolean
  skipCaptureErrorsInPdf?: boolean
}

export function bindBatchLabelExport<T>(options: BatchLabelExportOptions<T>) {
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

interface SingleLabelExportOptions {
  printButton: HTMLButtonElement
  printPdfCheckbox: HTMLInputElement
  exportPngBtn: HTMLButtonElement
  exportAmlBtn: HTMLButtonElement
  exportPdfBtn: HTMLButtonElement
  labelElement: HTMLElement
  pixelRatio?: number
  getTranslation: (key: string, fallback: string) => string
  buildBaseName: () => string
  pdfName?: () => string
  getDimensions: () => { widthMm: number; heightMm: number }
  refreshPreview: () => Promise<void>
  browserPrint: BrowserPrintBinding
  captureLabel?: () => Promise<string>
  createPdf?: LabelPdfFactoryOverride
}

export function bindSingleLabelExport(options: SingleLabelExportOptions) {
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
      capture: async labelElement => {
        if (options.captureLabel) return options.captureLabel()
        return captureLabelElement(labelElement, {
          pixelRatio: options.pixelRatio ?? LABEL_EXPORT_PIXEL_RATIO,
          resetTransform: true,
        })
      },
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
