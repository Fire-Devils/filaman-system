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
import {
  applyLabelSheetPreviewZoom,
  syncLabelSheetIndividualExportState,
  syncLabelSheetPreview,
  type LabelSheetControls,
  type LabelSheetSource,
} from './label-sheet'
import { bindFixedPreviewToolbar } from './label-preview-dom'
import { LabelOutputAssetError } from './label-output-readiness'

function outputFailureMessage(message: string, error: unknown) {
  return error instanceof LabelOutputAssetError ? `${message}\n${error.message}` : message
}
import {
  bindTemporaryPdfPreview,
  type TemporaryPdfPreviewController,
} from './label-pdf-preview'
import { type StandardLabelSettings } from './label-standard'

export { LABEL_EXPORT_DPI, LABEL_EXPORT_PIXEL_RATIO } from './label-export'

export const LABEL_PRINT_PDF_MODE_KEY = 'filaman-label-print-pdf-v1'

export interface PdfOutputActionsOptions {
  pdfButton: HTMLButtonElement
  printButton: HTMLButtonElement
  createPdf: () => Promise<LabelPdfDocument | null>
  getFilename: () => string
  getTranslation: (key: string, fallback: string) => string
  getPdfPreview: () => TemporaryPdfPreviewController
  coordinator?: LabelOutputCoordinator
}

interface LabelOutputCoordinator {
  run(
    action: () => Promise<void>,
    prepare?: () => boolean,
  ): Promise<void>
}

export function createPreviewRenderCoordinator() {
  const pendingRenders = new Set<Promise<void>>()

  return {
    run(render: () => Promise<void>) {
      const pending = Promise.resolve().then(render)
      pendingRenders.add(pending)
      pending.then(
        () => pendingRenders.delete(pending),
        () => pendingRenders.delete(pending),
      )
      return pending
    },
    async settle() {
      while (pendingRenders.size > 0) {
        await Promise.all(pendingRenders)
      }
    },
  }
}

function createLabelOutputCoordinator(
  buttons: HTMLButtonElement[],
  getLockControls: () => HTMLElement[] = () => [],
): LabelOutputCoordinator {
  let operationRunning = false

  return {
    async run(action, prepare) {
      if (operationRunning) return
      operationRunning = true
      let lockedStates: Array<{
        control: HTMLElement
        inert: boolean
      }> = []

      try {
        if (prepare && !prepare()) return
        const outputButtons = new Set(buttons)
        lockedStates = getLockControls()
          .filter(control => !outputButtons.has(control as HTMLButtonElement))
          .map(control => ({ control, inert: control.hasAttribute('inert') }))
        lockedStates.forEach(({ control }) => {
          control.setAttribute('inert', '')
        })
        await action()
      } finally {
        lockedStates.forEach(({ control, inert }) => {
          if (!inert) control.removeAttribute('inert')
        })
        operationRunning = false
      }
    },
  }
}

export function bindPdfOutputActions(
  options: PdfOutputActionsOptions,
) {
  const coordinator = options.coordinator ??
    createLabelOutputCoordinator([options.pdfButton])

  const execute = async (
    target: 'download' | 'print',
  ): Promise<void> => {
    try {
      let printPdf: LabelPdfDocument | undefined
      await coordinator.run(async () => {
        const pdf = await options.createPdf()
        if (!pdf) return

        if (target === 'download') pdf.save(options.getFilename())
        else printPdf = pdf
      })

      // Snapshot and hide the editor only after its temporary output lock is released.
      if (printPdf) {
        options.getPdfPreview().show({
          blob: printPdf.output('blob'),
          filename: options.getFilename(),
          returnFocus: options.printButton,
        })
      }
    } catch (error) {
      window.alert(
        outputFailureMessage(options.getTranslation(
          target === 'print'
            ? 'labelPrint.printPdfFailed'
            : 'labelPrint.pdfExportFailed',
          target === 'print'
            ? 'Print PDF generation failed.'
            : 'PDF export failed.',
        ), error),
      )
      console.error(
        target === 'print'
          ? 'Failed to create print PDF:'
          : 'Failed to export label PDF:',
        error,
      )
    }
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
      async () => {
        try {
          await printLabelBrowserJob(
            await options.createBrowserPrintJob(),
          )
        } catch (error) {
          cleanupLabelBrowserPrint()
          window.alert(outputFailureMessage(options.getTranslation(
            'labelPrint.browserPrintFailed',
            'Browser printing failed.',
          ), error))
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

function requireElement<T extends Element>(
  root: ParentNode,
  id: string,
  constructor: new (...args: never[]) => T,
): T {
  const element = root.querySelector(`#${id}`)
  if (!(element instanceof constructor)) {
    throw new Error(`Missing label print control: #${id}`)
  }
  return element
}

export function bindPrintPageSidebarCollapse() {
  const applyCollapse = () => {
    const page = document.getElementById('fm-page')
    // Expanded app nav (260px) + designer settings (360px) + editable workspace (600px) + breathing room.
    if (!page || window.innerWidth >= 1260) return
    document.documentElement.classList.add('sidebar-collapsed')
    page.classList.add('collapsed')
    if (window.innerWidth > 768) {
      writeStorageValue('sidebar-collapsed', 'true')
    }
  }

  applyCollapse()
  window.addEventListener('resize', applyCollapse, { passive: true })
  return () => window.removeEventListener('resize', applyCollapse)
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

export function readVersionedLabelSettings<T extends object>(
  storageKey: string,
  minimumVersion: number,
): T | null {
  const raw = readStorageValue(storageKey)
  if (!raw) return null

  let settings: unknown
  try {
    settings = JSON.parse(raw)
  } catch {
    return null
  }
  const version = Number((settings as { _v?: unknown } | null)?._v ?? 0)
  if (
    !settings ||
    typeof settings !== 'object' ||
    Array.isArray(settings) ||
    !Number.isFinite(version) ||
    version < minimumVersion
  ) {
    writeStorageValue(storageKey, '')
    return null
  }
  return settings as T
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
  zoomOutBtn?: HTMLElement | null
  zoomInBtn?: HTMLElement | null
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
  const max = options.max ?? 500
  const step = options.step ?? 5
  const buttonStep = options.buttonStep ?? 10
  const defaultZoom = options.defaultZoom ?? 100
  const translate = options.getTranslation

  const getZoom = () => clampNumber(Number(options.zoomInput.value), min, max, defaultZoom)

  const sync = () => {
    const zoom = getZoom()
    options.zoomInput.value = String(zoom)
  }

  const applyZoom = (nextZoom: number, snapStep = step) => {
    options.zoomInput.value = String(normalizeZoom(nextZoom, min, max, snapStep, defaultZoom))
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

  options.zoomInput.addEventListener('change', event => {
    applyZoom(Number((event.target as HTMLInputElement).value))
  })
  options.zoomOutBtn?.addEventListener('click', () => applyZoom(getZoom() - buttonStep))
  options.zoomInBtn?.addEventListener('click', () => applyZoom(getZoom() + buttonStep))

  sync()

  return { getZoom, applyZoom, sync }
}

export interface BindLabelPreviewZoomOptions {
  storageKey: string
  previewRoot: HTMLElement
  min?: number
  max?: number
  settingsVersion?: number
  readStoredZoom?(): number | null
  writeStoredZoom?(value: number): void
  onChange(): void
  getTranslation?(key: string, fallback: string): string
}

export interface LabelPreviewZoomBinding {
  getZoom(): number
  applyZoom(value: number): void
  sync(): void
}

export function bindLabelPreviewZoom(
  options: BindLabelPreviewZoomOptions,
): LabelPreviewZoomBinding {
  const root = options.previewRoot.closest('.preview-container') ?? document
  const binding = bindPreviewZoomControls({
    zoomInput: requireElement(root, 'preview-zoom-input', HTMLInputElement),
    zoomOutBtn: requireElement(root, 'preview-zoom-out', HTMLElement),
    zoomInBtn: requireElement(root, 'preview-zoom-in', HTMLElement),
    min: options.min,
    max: options.max,
    getTranslation: options.getTranslation,
    onChange: () => {
      const zoom = binding.getZoom()
      if (options.writeStoredZoom) options.writeStoredZoom(zoom)
      else if (options.settingsVersion !== undefined) {
        const settings = parseJsonOrNull<Record<string, unknown>>(
          readStorageValue(options.storageKey),
        ) ?? {}
        writeStorageValue(options.storageKey, JSON.stringify({ ...settings, zoom: String(zoom) }))
      } else writeStorageValue(options.storageKey, String(zoom))
      options.onChange()
    },
  })
  let wheelDelta = 0
  let wheelFrame: number | null = null
  let gestureZoom = binding.getZoom()
  let lastWheelAt = 0
  options.previewRoot.addEventListener('wheel', event => {
    if (!event.ctrlKey || !(event.target instanceof Element) || !event.target.closest('.label-preview, .label-sheet-page')) return
    event.preventDefault()
    if (event.timeStamp - lastWheelAt > 250) {
      wheelDelta = 0
      gestureZoom = binding.getZoom()
    }
    lastWheelAt = event.timeStamp
    wheelDelta += event.deltaY * (event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? 100 : 1)
    if (wheelFrame !== null) return
    wheelFrame = requestAnimationFrame(() => {
      gestureZoom *= Math.exp(-wheelDelta * 0.004)
      wheelDelta = 0
      wheelFrame = null
      binding.applyZoom(gestureZoom, 1)
      gestureZoom = binding.getZoom()
    })
  }, { passive: false })
  const storedZoom = options.readStoredZoom
    ? options.readStoredZoom()
    : options.settingsVersion !== undefined
      ? Number(readVersionedLabelSettings<{ zoom?: unknown }>(
          options.storageKey,
          options.settingsVersion,
        )?.zoom)
      : Number(readStorageValue(options.storageKey))
  const min = options.min ?? 25
  const max = options.max ?? 500
  if (storedZoom != null && storedZoom >= min && storedZoom <= max) {
    binding.applyZoom(storedZoom)
  }
  return binding
}

export interface LabelSettingsControls {
  width: HTMLInputElement
  height: HTMLInputElement
  fontSize: HTMLInputElement
  qrSize: HTMLInputElement
  showLogo: HTMLInputElement
  showQr: HTMLInputElement
  showId: HTMLInputElement
  showManufacturer: HTMLInputElement
  showMaterial: HTMLInputElement
  showColor: HTMLInputElement
  showColorSwatch: HTMLInputElement
  showColorHex: HTMLInputElement
}

const LABEL_SETTING_INPUTS = [
  ['width', 'width', 'widthMm', 20, 200, 60, 3, 1],
  ['height', 'height', 'heightMm', 10, 120, 40, 3, 1],
  ['fontSize', 'fontSize', 'fontScale', 50, 200, 100, 0, 100],
  ['qrSize', 'qrSize', 'qrSizeMm', 8, 40, 18, 1, 1],
] as const

const LABEL_SETTING_CHECKBOXES = [
  ['showLogo', 'showLogo', 'showLogo'],
  ['showQR', 'showQr', 'showQR'],
  ['showID', 'showId', 'showID'],
  ['showMfr', 'showManufacturer', 'showManufacturer'],
  ['showMat', 'showMaterial', 'showMaterial'],
  ['showColor', 'showColor', 'showColor'],
  ['showColorSwatch', 'showColorSwatch', 'showColorSwatch'],
  ['showColorHex', 'showColorHex', 'showColorHex'],
] as const

type LabelSettingsStateKey =
  | typeof LABEL_SETTING_INPUTS[number][0]
  | typeof LABEL_SETTING_CHECKBOXES[number][0]
export type LabelSettingsState = Partial<Record<LabelSettingsStateKey, unknown>>
  & { extraFields?: unknown }
type LabelExtraFieldControls = Record<string, HTMLInputElement>

export function getLabelSettingsControls(
  root: ParentNode = document,
): LabelSettingsControls {
  return {
    width: requireElement(root, 'input-width', HTMLInputElement),
    height: requireElement(root, 'input-height', HTMLInputElement),
    fontSize: requireElement(root, 'input-font-size', HTMLInputElement),
    qrSize: requireElement(root, 'input-qr-size', HTMLInputElement),
    showLogo: requireElement(root, 'check-logo', HTMLInputElement),
    showQr: requireElement(root, 'check-qr', HTMLInputElement),
    showId: requireElement(root, 'check-id', HTMLInputElement),
    showManufacturer: requireElement(root, 'check-mfr', HTMLInputElement),
    showMaterial: requireElement(root, 'check-mat', HTMLInputElement),
    showColor: requireElement(root, 'check-color', HTMLInputElement),
    showColorSwatch: requireElement(root, 'check-color-swatch', HTMLInputElement),
    showColorHex: requireElement(root, 'check-color-hex', HTMLInputElement),
  }
}

export function captureLabelSettings(
  controls: LabelSettingsControls,
  extraFields?: LabelExtraFieldControls,
): LabelSettingsState {
  const settings = Object.fromEntries([
    ...LABEL_SETTING_INPUTS.map(([setting, control]) => [setting, controls[control].value]),
    ...LABEL_SETTING_CHECKBOXES.map(([setting, control]) => [setting, controls[control].checked]),
  ]) as LabelSettingsState
  if (extraFields) settings.extraFields = Object.fromEntries(
    Object.entries(extraFields).map(([key, checkbox]) => [key, checkbox.checked]),
  )
  return settings
}

export function restoreLabelSettings(
  controls: LabelSettingsControls,
  settings: LabelSettingsState,
  extraFields?: LabelExtraFieldControls,
  options: { requireInputValues?: boolean } = {},
) {
  for (const [setting, control] of LABEL_SETTING_INPUTS) {
    const value = settings[setting]
    if (value !== undefined && (!options.requireInputValues || Boolean(value))) {
      controls[control].value = String(value)
    }
  }
  for (const [setting, control] of LABEL_SETTING_CHECKBOXES) {
    const value = settings[setting]
    if (value !== undefined) controls[control].checked = Boolean(value)
  }
  if (extraFields && settings.extraFields && typeof settings.extraFields === 'object') {
    Object.entries(settings.extraFields as Record<string, boolean>).forEach(([key, checked]) => {
      if (extraFields[key]) extraFields[key].checked = checked
    })
  }
}

export function resetLabelSettings(
  controls: LabelSettingsControls,
  extraFields?: LabelExtraFieldControls,
) {
  LABEL_SETTING_INPUTS.forEach(([, control, , , , fallback]) => {
    controls[control].value = String(fallback)
  })
  LABEL_SETTING_CHECKBOXES.forEach(([, control]) => {
    controls[control].checked = true
  })
  Object.values(extraFields ?? {}).forEach(checkbox => { checkbox.checked = false })
}

export function appendLabelSettingsCheckbox(options: {
  container: HTMLElement
  id?: string
  label: string
  checked: boolean
  onChange(): void
}) {
  const row = document.createElement('label')
  const checkbox = document.createElement('input')
  const label = document.createElement('span')
  const scopeName = Array.from(
    document.querySelector('.fm-checkbox-group')?.attributes ?? [],
  ).find(attribute => attribute.name.startsWith('data-astro-cid-'))?.name
  row.className = 'fm-checkbox-group'
  checkbox.type = 'checkbox'
  if (options.id) checkbox.id = options.id
  checkbox.checked = options.checked
  label.textContent = options.label
  if (scopeName) [row, checkbox, label].forEach(element => element.setAttribute(scopeName, ''))
  row.append(checkbox, label)
  options.container.appendChild(row)
  checkbox.addEventListener('change', () => options.onChange())
  return checkbox
}

export function getStandardLabelSettings(
  controls: LabelSettingsControls,
  options: { normalizeInputs?: boolean; integerFontScale?: boolean } = {},
): StandardLabelSettings {
  const read = (
    input: HTMLInputElement,
    min: number,
    max: number,
    fallback: number,
    decimals: number,
    integer = false,
  ) => options.normalizeInputs
    ? clampInputValue(input, min, max, fallback, decimals)
    : clampNumber(integer ? parseInt(input.value) : Number(input.value), min, max, fallback)
  return {
    ...Object.fromEntries(LABEL_SETTING_INPUTS.map(([
      setting, control, output, min, max, fallback, decimals, scale,
    ]) => [output, read(
      controls[control], min, max, fallback, decimals,
      options.integerFontScale && setting === 'fontSize',
    ) / scale])),
    ...Object.fromEntries(LABEL_SETTING_CHECKBOXES.map(([, control, output]) => (
      [output, controls[control].checked]
    ))),
  } as unknown as StandardLabelSettings
}

export interface BindLabelSettingsEventsOptions {
  controls: LabelSettingsControls
  resetButton?: HTMLElement | null
  onChange(): void
  onReset(): void
}

export function bindLabelSettingsEvents(
  options: BindLabelSettingsEventsOptions,
) {
  const inputs = Object.values(options.controls)
  const liveInputs = inputs.filter(input =>
    input.type === 'range' || input.type === 'number',
  )
  const onChange = () => options.onChange()
  const onReset = () => options.onReset()
  inputs.forEach(input => input.addEventListener('change', onChange))
  liveInputs.forEach(input => input.addEventListener('input', onChange))
  options.resetButton?.addEventListener('click', onReset)

  return () => {
    inputs.forEach(input => input.removeEventListener('change', onChange))
    liveInputs.forEach(input => input.removeEventListener('input', onChange))
    options.resetButton?.removeEventListener('click', onReset)
  }
}

export function applyBatchLabelPreviewZoom(previewRoot: HTMLElement, zoomPercent: number) {
  const zoom = normalizeZoom(Number(zoomPercent), 25, 500, 1, 100) / 100
  bindFixedPreviewToolbar({ previewRoot })
  const directWrappers = Array.from(previewRoot.children)
    .filter((element): element is HTMLElement => element instanceof HTMLElement && element.classList.contains('label-wrapper'))
  const canvasWrappers = Array.from(previewRoot.querySelectorAll<HTMLElement>(
    '.freeform-canvas-host > .label-wrapper',
  ))
  const labels = [...directWrappers, ...canvasWrappers].map(wrapper => {
    if (wrapper.classList.contains('is-designer-output-only')) return null
    const label = Array.from(wrapper.children).find(
      (element): element is HTMLElement => element instanceof HTMLElement && element.classList.contains('label-preview'),
    )
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

export function applySingleLabelPreviewZoom(label: HTMLElement, zoomPercent: number) {
  const zoom = normalizeZoom(Number(zoomPercent), 25, 500, 1, 100) / 100
  label.style.transform = `scale(${zoom})`
  label.style.transformOrigin = label.closest('#freeform-designer-workspace.is-active')
    ? 'top left'
    : 'center center'
}

export type PrintWorkspaceMode = 'standard' | 'designer' | 'sheets'
export type PrintLabelSource = 'standard' | 'designer'

export interface ResolvedPrintWorkspace {
  mode: PrintWorkspaceMode
  source: PrintLabelSource
  outputMode: 'individual' | 'sheet'
}

export function singleLabelPrintUrl(entityType: 'spool' | 'filament', ids: number[]): string | null {
  return ids.length === 1 ? `/${entityType}s/${ids[0]}/print` : null
}

export interface PrintWorkspaceSnapshot<T> extends ResolvedPrintWorkspace {
  previewIndex: number
  representativeItem: T | undefined
  previewItems: T[]
  outputItems: T[]
}

interface PrintWorkspaceCoordinatorOptions<T> {
  initialMode: PrintWorkspaceMode
  getItems: () => readonly T[]
  getSheetSource: () => LabelSheetSource
  onModeChange: (state: PrintWorkspaceSnapshot<T>) => void
}

export function resolvePrintWorkspace(
  mode: PrintWorkspaceMode,
  sheetSource: LabelSheetSource,
): ResolvedPrintWorkspace {
  return {
    mode,
    source: mode === 'sheets' ? sheetSource.type : mode,
    outputMode: mode === 'sheets' ? 'sheet' : 'individual',
  }
}

export function getPrintWorkspacePreviewItems<T>(
  mode: PrintWorkspaceMode,
  items: readonly T[],
  index = 0,
): T[] {
  return mode === 'designer' ? items.slice(index, index + 1) : [...items]
}

export function getPrintWorkspaceOutputItems<T>(items: readonly T[]): T[] {
  return [...items]
}

export function createPrintWorkspaceCoordinator<T>(
  options: PrintWorkspaceCoordinatorOptions<T>,
) {
  let activeMode = options.initialMode
  let previewIndex = 0
  const getPreviewIndex = (itemCount = options.getItems().length) =>
    Math.max(0, Math.min(previewIndex, itemCount - 1))

  const getState = (mode = activeMode): PrintWorkspaceSnapshot<T> => {
    const items = getPrintWorkspaceOutputItems(options.getItems())
    previewIndex = getPreviewIndex(items.length)
    const source = options.getSheetSource()
    const resolved = resolvePrintWorkspace(mode, source)
    return {
      ...resolved,
      previewIndex,
      representativeItem: items[previewIndex],
      previewItems: getPrintWorkspacePreviewItems(mode, items, previewIndex),
      outputItems: items,
    }
  }

  return {
    selectPreview(index: number) {
      const previous = getState().previewIndex
      previewIndex = Number.isFinite(index) ? Math.trunc(index) : previous
      const state = getState()
      if (state.previewIndex !== previous) options.onModeChange(state)
      return state
    },
    activate(mode: PrintWorkspaceMode) {
      activeMode = mode
      const state = getState()
      options.onModeChange(state)
      return state
    },
    getState,
    getPreviewIndex,
    getActiveMode: () => activeMode,
    getSource: () => resolvePrintWorkspace(activeMode, options.getSheetSource()).source,
    getRepresentativeItem: () => getState().representativeItem,
    getPreviewItems: () => getState().previewItems,
    getOutputItems: () => getPrintWorkspaceOutputItems(options.getItems()),
  }
}

export function syncDesignerRepresentativeElements(
  mode: PrintWorkspaceMode,
  elements: readonly HTMLElement[],
  previewIndex = 0,
) {
  elements.forEach((element, index) => {
    const representative = mode === 'designer' && index === previewIndex
    const outputOnly = mode === 'designer' && !representative
    element.classList.toggle('is-designer-representative', representative)
    element.classList.toggle('is-designer-output-only', outputOnly)
    if (outputOnly) element.setAttribute('aria-hidden', 'true')
    else element.removeAttribute('aria-hidden')
  })
  // The shared editor targets the first label; output uses the original item order.
  const active = elements[previewIndex]
  if (mode === 'designer') active?.parentElement?.prepend(active)
  else elements[0]?.parentElement?.append(...elements)
}

interface PrintWorkspaceTabsOptions {
  buttons: Iterable<HTMLButtonElement>
  panels: Record<PrintWorkspaceMode, HTMLElement>
  outputButtons?: {
    print: HTMLButtonElement
    pdf: HTMLButtonElement
    png: HTMLButtonElement
    aml: HTMLButtonElement
  }
  resetButton?: HTMLElement | null
  sidebar?: HTMLElement | null
  designerWorkspace?: HTMLElement | null
  sheetControls?: Pick<LabelSheetControls, 'setOutputMode'>
  storageKey: string
  initialMode?: PrintWorkspaceMode
  onChange: (mode: PrintWorkspaceMode) => void
}

export function readPrintWorkspaceMode(
  storageKey: string,
  fallback: PrintWorkspaceMode = 'standard',
): PrintWorkspaceMode {
  const stored = readStorageValue(storageKey)
  return stored === 'standard' || stored === 'designer' || stored === 'sheets'
    ? stored
    : fallback
}

export function bindPrintWorkspaceTabs(options: PrintWorkspaceTabsOptions) {
  let activeMode = options.initialMode ?? readPrintWorkspaceMode(options.storageKey)
  const buttons = Array.from(options.buttons)
  const zoom = options.designerWorkspace?.closest('.preview-container')?.querySelector('.preview-zoom-bar')
  const zoomParent = zoom?.parentNode
  const zoomNext = zoom?.nextSibling ?? null
  const zoomSlot = options.designerWorkspace?.querySelector('.freeform-zoom-slot')

  const activate = (mode: PrintWorkspaceMode) => {
    activeMode = mode
    buttons.forEach(button => {
      const active = button.dataset.workspaceMode === mode
      button.classList.toggle('active', active)
      button.setAttribute('aria-selected', String(active))
      button.tabIndex = active ? 0 : -1
    })
    for (const [panelMode, panel] of Object.entries(options.panels)) {
      panel.hidden = panelMode !== mode
    }
    const sheetMode = mode === 'sheets'
    if (options.outputButtons) {
      options.outputButtons.png.hidden = sheetMode
      options.outputButtons.aml.hidden = sheetMode
      options.outputButtons.pdf.hidden = false
      options.outputButtons.print.hidden = false
    }
    if (options.resetButton) options.resetButton.hidden = mode !== 'standard'
    options.sidebar?.classList.toggle('sidebar-wide', mode === 'designer')
    options.sidebar?.classList.toggle('sidebar-sheets-wide', sheetMode)
    options.designerWorkspace?.classList.toggle('is-active', mode === 'designer')
    if (zoom && zoomParent && zoomSlot) {
      if (mode === 'designer') zoomSlot.appendChild(zoom)
      else zoomParent.insertBefore(zoom, zoomNext)
    }
    writeStorageValue(options.storageKey, mode)
    options.sheetControls?.setOutputMode(
      mode === 'sheets' ? 'sheet' : 'individual',
      { notify: false },
    )
    options.onChange(mode)
  }

  buttons.forEach(button => {
    button.setAttribute('role', 'tab')
    button.addEventListener('click', () => {
      const mode = button.dataset.workspaceMode
      activate(mode === 'designer' || mode === 'sheets' ? mode : 'standard')
    })
    button.addEventListener('keydown', event => {
      const current = buttons.indexOf(button)
      const next = event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? buttons.length - 1
          : event.key === 'ArrowRight'
            ? (current + 1) % buttons.length
            : event.key === 'ArrowLeft'
              ? (current - 1 + buttons.length) % buttons.length
              : -1
      if (next < 0) return
      event.preventDefault()
      const destination = buttons[next]
      const mode = destination.dataset.workspaceMode
      activate(mode === 'designer' || mode === 'sheets' ? mode : 'standard')
      destination.focus()
    })
  })

  return {
    activate,
    getActiveMode: () => activeMode,
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
      if (!canSkipCaptureError || error instanceof LabelOutputAssetError) throw error
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

export function getLabelOutputControls(
  root: ParentNode = document,
): LabelOutputControls {
  return {
    printButton: requireElement(root, 'btn-print', HTMLButtonElement),
    printPdfCheckbox: requireElement(root, 'check-print-pdf', HTMLInputElement),
    pngButton: requireElement(root, 'btn-export-png', HTMLButtonElement),
    amlButton: requireElement(root, 'btn-export-aml', HTMLButtonElement),
    pdfButton: requireElement(root, 'btn-export-pdf', HTMLButtonElement),
  }
}

export interface BindLabelOutputPreviewOptions {
  previewRoot: HTMLElement
  sheetControls: LabelSheetControls
  outputControls: LabelOutputControls
  getSourceElements(): HTMLElement[]
  getDimensions(): { widthMm: number; heightMm: number }
  getZoom(): number
  applyIndividualZoom(zoom: number): void
}

export function bindLabelOutputPreview(
  options: BindLabelOutputPreviewOptions,
) {
  return (zoomOnly = false) => {
    if (!zoomOnly) {
      syncLabelSheetPreview({
        controls: options.sheetControls,
        previewRoot: options.previewRoot,
        sourceElements: options.getSourceElements(),
        labelDimensions: options.getDimensions(),
      })
    }
    const zoom = options.getZoom()
    if (options.sheetControls.getOutputMode() === 'sheet') {
      applyLabelSheetPreviewZoom(options.previewRoot, zoom)
    } else {
      options.applyIndividualZoom(zoom)
    }
    if (!zoomOnly) {
      syncLabelSheetIndividualExportState(
        options.sheetControls,
        [options.outputControls.pngButton, options.outputControls.amlButton],
        (key, fallback) =>
          (window as Window & { __t?: (key: string) => string }).__t?.(key) ||
          fallback,
      )
    }
  }
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
  pdfPreview?: TemporaryPdfPreviewController
}

export function bindLabelOutputs<T>(options: BindLabelOutputsOptions<T>) {
  const { controls, collection, getTranslation } = options
  let pdfPreview = options.pdfPreview
  const getPdfPreview = () => {
    pdfPreview ??= bindTemporaryPdfPreview({ root: document, getTranslation })
    return pdfPreview
  }
  const coordinator = createLabelOutputCoordinator(
    [
      controls.printButton,
      controls.pngButton,
      controls.amlButton,
      controls.pdfButton,
    ],
    () => Array.from(document.querySelectorAll<HTMLElement>(
      '.print-sidebar button, .print-sidebar input, .print-sidebar select, ' +
      '.print-sidebar textarea, .preview-zoom-bar button, .preview-zoom-bar input, ' +
      '#freeform-designer-workspace',
    )),
  )

  const exportFiles = async (kind: 'png' | 'aml') => {
    const button = kind === 'png' ? controls.pngButton : controls.amlButton
    if (button.getAttribute('aria-disabled') === 'true') return
    const items = collection.getItems()
    if (items.length === 0) return

    await coordinator.run(async () => {
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
        window.alert(outputFailureMessage(getTranslation(
          isPng ? 'labelPrint.pngExportFailed' : 'labelPrint.amlExportFailed',
          isPng ? 'PNG export failed.' : 'AML export failed.',
        ), error))
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
    printButton: controls.printButton,
    createPdf,
    getFilename: collection.pdfName,
    getTranslation,
    getPdfPreview,
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
