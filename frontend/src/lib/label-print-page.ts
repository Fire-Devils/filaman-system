import { LABEL_EXPORT_PIXEL_RATIO, captureLabelElement, downloadDataUrl, saveLabelPagesAsPdf } from './label-export'

export { LABEL_EXPORT_DPI, LABEL_EXPORT_PIXEL_RATIO } from './label-export'

declare global {
  interface Window {
    filamanPrint?: () => void
    filamanExportPNG?: () => Promise<void>
    filamanExportPDF?: () => Promise<void>
  }
}

const STORAGE_SOFT_LIMIT_BYTES = 4_500_000

export function installPrintFunction() {
  window.filamanPrint = function() {
    requestAnimationFrame(() => {
      try {
        if (document.execCommand('print', false, undefined)) return
      } catch {
        // Fall back below.
      }
      window.print()
    })
  }
}

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

const fixedBatchToolbarRoots = new WeakSet<HTMLElement>()
const pendingBatchToolbarSync = new WeakSet<HTMLElement>()

function getPreviewToolbar(previewRoot: HTMLElement) {
  const toolbar = previewRoot.querySelector('.preview-zoom-bar')
  return toolbar instanceof HTMLElement ? toolbar : null
}

function syncFixedBatchToolbar(previewRoot: HTMLElement) {
  const toolbar = getPreviewToolbar(previewRoot)
  if (!toolbar) return
  const rect = previewRoot.getBoundingClientRect()
  toolbar.style.position = 'fixed'
  toolbar.style.top = `${rect.top}px`
  toolbar.style.left = `${rect.left + rect.width / 2}px`
  toolbar.style.transform = 'translateX(-50%)'
}

function scheduleFixedBatchToolbarSync(previewRoot: HTMLElement) {
  if (pendingBatchToolbarSync.has(previewRoot)) return
  pendingBatchToolbarSync.add(previewRoot)
  requestAnimationFrame(() => {
    pendingBatchToolbarSync.delete(previewRoot)
    syncFixedBatchToolbar(previewRoot)
  })
}

function bindFixedBatchToolbar(previewRoot: HTMLElement) {
  syncFixedBatchToolbar(previewRoot)
  if (fixedBatchToolbarRoots.has(previewRoot)) return
  fixedBatchToolbarRoots.add(previewRoot)
  previewRoot.addEventListener('scroll', () => scheduleFixedBatchToolbarSync(previewRoot), { passive: true })
  window.addEventListener('resize', () => scheduleFixedBatchToolbarSync(previewRoot), { passive: true })
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
  bindFixedBatchToolbar(previewRoot)
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

interface BatchLabelExportOptions<T> {
  entities: () => T[]
  activeTab: () => PrintDesignerTab
  pngButton: HTMLButtonElement
  pdfButton: HTMLButtonElement
  getTranslation: (key: string, fallback: string) => string
  renderAll: (tab: PrintDesignerTab) => Promise<void>
  captureLabel: (entity: T) => Promise<string>
  getPdfDimensions: () => { widthMm: number; heightMm: number }
  singlePngName: (entity: T) => string
  zipName: () => string
  zipEntryName: (entity: T) => string
  pdfName: () => string
  exportPdf?: (
    pages: { dataUrl: string; widthMm: number; heightMm: number }[],
    defaultExport: () => Promise<void>,
  ) => Promise<void>
  skipCaptureErrorsInZip?: boolean
  skipCaptureErrorsInPdf?: boolean
}

async function withDisabledExportButton(button: HTMLButtonElement, exportingText: string, action: () => Promise<void>) {
  const originalText = button.textContent
  button.disabled = true
  button.textContent = exportingText
  try {
    await action()
  } finally {
    button.disabled = false
    button.textContent = originalText
  }
}

export function bindBatchLabelExport<T>(options: BatchLabelExportOptions<T>) {
  const exportingText = () => options.getTranslation('labelPrint.exporting', 'Exporting...')

  window.filamanExportPNG = async function() {
    if (options.pngButton.disabled || options.pngButton.getAttribute('aria-disabled') === 'true') return
    const entities = options.entities()
    if (entities.length === 0) return

    await withDisabledExportButton(options.pngButton, exportingText(), async () => {
      try {
        await options.renderAll(options.activeTab())
        if (entities.length === 1) {
          downloadDataUrl(await options.captureLabel(entities[0]), options.singlePngName(entities[0]))
          return
        }

        const JSZip = (await import('jszip')).default
        const zip = new JSZip()
        for (const entity of entities) {
          try {
            const dataUrl = await options.captureLabel(entity)
            zip.file(options.zipEntryName(entity), dataUrl.split(',')[1], { base64: true })
          } catch (error) {
            if (!options.skipCaptureErrorsInZip) throw error
          }
        }

        const url = URL.createObjectURL(await zip.generateAsync({ type: 'blob' }))
        downloadDataUrl(url, options.zipName())
        setTimeout(() => URL.revokeObjectURL(url), 60000)
      } catch (error) {
        alert(options.getTranslation('labelPrint.pngExportFailed', 'PNG export failed.'))
        console.error(error)
      }
    })
  }

  window.filamanExportPDF = async function() {
    const entities = options.entities()
    if (entities.length === 0) return

    await withDisabledExportButton(options.pdfButton, exportingText(), async () => {
      try {
        await options.renderAll(options.activeTab())
        const dimensions = options.getPdfDimensions()
        const pages: { dataUrl: string; widthMm: number; heightMm: number }[] = []
        for (const entity of entities) {
          try {
            pages.push({
              dataUrl: await options.captureLabel(entity),
              widthMm: dimensions.widthMm,
              heightMm: dimensions.heightMm,
            })
          } catch (error) {
            if (!options.skipCaptureErrorsInPdf) throw error
          }
        }
        if (pages.length === 0) return
        const defaultExport = async () => saveLabelPagesAsPdf(pages, options.pdfName())
        if (options.exportPdf) await options.exportPdf(pages, defaultExport)
        else await defaultExport()
      } catch (error) {
        alert(options.getTranslation('labelPrint.pdfExportFailed', 'PDF export failed.'))
        console.error(error)
      }
    })
  }
}

interface SingleLabelExportOptions {
  exportPngBtn: HTMLButtonElement
  exportPdfBtn: HTMLButtonElement
  labelElement: HTMLElement
  pixelRatio?: number
  getTranslation: (key: string, fallback: string) => string
  buildBaseName: () => string
  getDimensions: () => { widthMm: number; heightMm: number }
  refreshPreview: () => Promise<void>
  exportPdf?: (defaultExport: () => Promise<void>) => Promise<void>
}

export function bindSingleLabelExport(options: SingleLabelExportOptions) {
  const captureActiveLabelPng = async () => {
    await options.refreshPreview()
    return captureLabelElement(options.labelElement, {
      pixelRatio: options.pixelRatio ?? LABEL_EXPORT_PIXEL_RATIO,
      resetTransform: true,
    })
  }

  const withExportButtonsDisabled = async (action: () => Promise<void>) => {
    const pngText = options.exportPngBtn.textContent
    const pdfText = options.exportPdfBtn.textContent
    options.exportPngBtn.disabled = true
    options.exportPdfBtn.disabled = true
    options.exportPngBtn.textContent = options.getTranslation('labelPrint.exporting', 'Exporting...')
    options.exportPdfBtn.textContent = options.getTranslation('labelPrint.exporting', 'Exporting...')
    try {
      await action()
    } finally {
      options.exportPngBtn.disabled = false
      options.exportPdfBtn.disabled = false
      options.exportPngBtn.textContent = pngText
      options.exportPdfBtn.textContent = pdfText
    }
  }

  options.exportPngBtn.addEventListener('click', () => {
    void withExportButtonsDisabled(async () => {
      try {
        downloadDataUrl(await captureActiveLabelPng(), `${options.buildBaseName()}.png`)
      } catch (error) {
        alert(options.getTranslation('labelPrint.pngExportFailed', 'PNG export failed.'))
        console.error('Failed to export label PNG:', error)
      }
    })
  })

  options.exportPdfBtn.addEventListener('click', () => {
    void withExportButtonsDisabled(async () => {
      try {
        const defaultExport = async () => {
          const { widthMm, heightMm } = options.getDimensions()
          await saveLabelPagesAsPdf(
            [{ dataUrl: await captureActiveLabelPng(), widthMm, heightMm }],
            `${options.buildBaseName()}.pdf`,
          )
        }
        if (options.exportPdf) await options.exportPdf(defaultExport)
        else await defaultExport()
      } catch (error) {
        alert(options.getTranslation('labelPrint.pdfExportFailed', 'PDF export failed.'))
        console.error('Failed to export label PDF:', error)
      }
    })
  })
}
