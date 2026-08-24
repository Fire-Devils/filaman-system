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
} from './label-sheet'
import { bindFixedPreviewToolbar } from './label-preview-dom'
import { type StandardLabelSettings } from './label-standard'

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
  getLockControls: () => Array<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement> = () => [],
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
      let lockedStates: Array<{
        control: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement
        disabled: boolean
      }> = []

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
        const outputButtons = new Set(buttons)
        lockedStates = getLockControls()
          .filter(control => !outputButtons.has(control as HTMLButtonElement))
          .map(control => ({ control, disabled: control.disabled }))
        lockedStates.forEach(({ control }) => {
          control.disabled = true
        })
        await action()
      } finally {
        lockedStates.forEach(({ control, disabled }) => {
          control.disabled = disabled
        })
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
    if (!page || window.innerWidth >= 1100) return
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
  const slider = requireElement(root, 'preview-zoom-slider', HTMLInputElement)
  const binding = bindPreviewZoomControls({
    zoomInput: slider,
    slider,
    label: requireElement(root, 'preview-zoom-label', HTMLElement),
    zoomOutBtn: requireElement(root, 'preview-zoom-out', HTMLElement),
    zoomInBtn: requireElement(root, 'preview-zoom-in', HTMLElement),
    zoomResetBtn: requireElement(root, 'preview-zoom-reset', HTMLElement),
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
  const storedZoom = options.readStoredZoom
    ? options.readStoredZoom()
    : options.settingsVersion !== undefined
      ? Number(readVersionedLabelSettings<{ zoom?: unknown }>(
          options.storageKey,
          options.settingsVersion,
        )?.zoom)
      : Number(readStorageValue(options.storageKey))
  const min = options.min ?? 25
  const max = options.max ?? 300
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
  ['width', 'width', 'widthMm', 20, 200, 60, 0, 1],
  ['height', 'height', 'heightMm', 10, 120, 40, 0, 1],
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
  checkbox.addEventListener('change', options.onChange)
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
  inputs.forEach(input => input.addEventListener('change', options.onChange))
  liveInputs.forEach(input => input.addEventListener('input', options.onChange))
  options.resetButton?.addEventListener('click', options.onReset)

  return () => {
    inputs.forEach(input => input.removeEventListener('change', options.onChange))
    liveInputs.forEach(input => input.removeEventListener('input', options.onChange))
    options.resetButton?.removeEventListener('click', options.onReset)
  }
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
  return () => {
    const sourceElements = options.getSourceElements()
    syncLabelSheetPreview({
      controls: options.sheetControls,
      previewRoot: options.previewRoot,
      sourceElements,
      labelDimensions: options.getDimensions(),
    })
    const zoom = options.getZoom()
    if (options.sheetControls.getOutputMode() === 'sheet') {
      applyLabelSheetPreviewZoom(options.previewRoot, zoom)
    } else {
      options.applyIndividualZoom(zoom)
    }
    syncLabelSheetIndividualExportState(
      options.sheetControls,
      [options.outputControls.pngButton, options.outputControls.amlButton],
      (key, fallback) =>
        (window as Window & { __t?: (key: string) => string }).__t?.(key) ||
        fallback,
    )
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
}

export function bindLabelOutputs<T>(options: BindLabelOutputsOptions<T>) {
  const { controls, collection, getTranslation } = options
  const exportingText = () => getTranslation('labelPrint.exporting', 'Exporting...')
  const coordinator = createLabelOutputCoordinator(
    [
      controls.printButton,
      controls.pngButton,
      controls.amlButton,
      controls.pdfButton,
    ],
    () => Array.from(document.querySelectorAll<
      HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement
    >(
      '.print-sidebar button, .print-sidebar input, .print-sidebar select, ' +
      '.print-sidebar textarea, .preview-zoom-bar button, .preview-zoom-bar input',
    )),
  )

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
