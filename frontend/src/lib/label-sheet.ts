import type { LabelPdfPage } from './label-export'

export const LABEL_SHEET_SETTINGS_KEY = 'filaman-label-sheet-settings-v1'
export const LABEL_SHEET_PRESETS_KEY = 'filaman-label-sheet-presets-v1'
export const LABEL_OUTPUT_MODE_KEY = 'filaman-label-output-mode-v1'

export type LabelOutputMode = 'individual' | 'sheet'

export interface LabelSheetSettings {
  paperSize: 'a4' | 'letter' | 'custom'
  customWidthMm: number
  customHeightMm: number
  rows: number
  columns: number
  marginTopMm: number
  marginRightMm: number
  marginBottomMm: number
  marginLeftMm: number
  gapHorizontalMm: number
  gapVerticalMm: number
  skipCells: number
  copies: number
  showGrid: boolean
  printGrid: boolean
  fitToCell: boolean
}

export type LabelSheetPresetSettings = Pick<
  LabelSheetSettings,
  | 'paperSize'
  | 'customWidthMm'
  | 'customHeightMm'
  | 'rows'
  | 'columns'
  | 'marginTopMm'
  | 'marginRightMm'
  | 'marginBottomMm'
  | 'marginLeftMm'
  | 'gapHorizontalMm'
  | 'gapVerticalMm'
  | 'printGrid'
  | 'fitToCell'
>

export interface LabelSheetPreset {
  id: string
  name: string
  settings: LabelSheetPresetSettings
  builtin?: boolean
}

export interface LabelSheetLayout {
  paperWidthMm: number
  paperHeightMm: number
  cellWidthMm: number
  cellHeightMm: number
  cellsPerPage: number
}

export interface LabelSheetControls {
  getOutputMode: () => LabelOutputMode
  getSettings: () => LabelSheetSettings
  setOutputMode: (mode: LabelOutputMode) => void
}

export interface LabelSheetPreviewOptions {
  previewRoot: HTMLElement
  sourceElements: HTMLElement[]
  settings: LabelSheetSettings
  labelWidthMm: number
  labelHeightMm: number
}

export interface SyncLabelSheetPreviewOptions {
  controls: LabelSheetControls
  previewRoot: HTMLElement
  sourceElements: HTMLElement[]
  labelDimensions: { widthMm: number; heightMm: number }
}

const SOURCE_BIN_CLASS = 'label-sheet-source-bin'
const SHEET_PAGE_FRAME_CLASS = 'label-sheet-page-frame'
const SHEET_MODE_CLASS = 'is-label-sheet-mode'
const PAGE_STYLE_ID = 'label-sheet-page-style'
const CUSTOM_PRESET_ID = '__custom'
const LARGE_JOB_LABEL_LIMIT = 500
const LARGE_JOB_PAGE_LIMIT = 50
const originalPositions = new WeakMap<HTMLElement, { parent: Node; nextSibling: Node | null }>()
const confirmedLargeJobs = new Set<string>()
const fixedToolbarPreviewRoots = new WeakSet<HTMLElement>()

const DEFAULT_SETTINGS: LabelSheetSettings = {
  paperSize: 'a4',
  customWidthMm: 210,
  customHeightMm: 297,
  rows: 8,
  columns: 3,
  marginTopMm: 10,
  marginRightMm: 10,
  marginBottomMm: 10,
  marginLeftMm: 10,
  gapHorizontalMm: 2,
  gapVerticalMm: 2,
  skipCells: 0,
  copies: 1,
  showGrid: false,
  printGrid: false,
  fitToCell: true,
}

const PAPER_SIZES = {
  a4: { widthMm: 210, heightMm: 297 },
  letter: { widthMm: 215.9, heightMm: 279.4 },
}

function clampNumber(value: unknown, min: number, max: number, fallback: number) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.min(max, Math.max(min, numeric))
}

function normalizeSettings(raw: Partial<LabelSheetSettings> | null | undefined): LabelSheetSettings {
  const paperSize = raw?.paperSize === 'letter' || raw?.paperSize === 'custom' ? raw.paperSize : 'a4'
  return {
    paperSize,
    customWidthMm: clampNumber(raw?.customWidthMm, 25, 1000, DEFAULT_SETTINGS.customWidthMm),
    customHeightMm: clampNumber(raw?.customHeightMm, 25, 1000, DEFAULT_SETTINGS.customHeightMm),
    rows: Math.round(clampNumber(raw?.rows, 1, 30, DEFAULT_SETTINGS.rows)),
    columns: Math.round(clampNumber(raw?.columns, 1, 10, DEFAULT_SETTINGS.columns)),
    marginTopMm: clampNumber(raw?.marginTopMm, 0, 100, DEFAULT_SETTINGS.marginTopMm),
    marginRightMm: clampNumber(raw?.marginRightMm, 0, 100, DEFAULT_SETTINGS.marginRightMm),
    marginBottomMm: clampNumber(raw?.marginBottomMm, 0, 100, DEFAULT_SETTINGS.marginBottomMm),
    marginLeftMm: clampNumber(raw?.marginLeftMm, 0, 100, DEFAULT_SETTINGS.marginLeftMm),
    gapHorizontalMm: clampNumber(raw?.gapHorizontalMm, 0, 50, DEFAULT_SETTINGS.gapHorizontalMm),
    gapVerticalMm: clampNumber(raw?.gapVerticalMm, 0, 50, DEFAULT_SETTINGS.gapVerticalMm),
    skipCells: Math.round(clampNumber(raw?.skipCells, 0, 300, DEFAULT_SETTINGS.skipCells)),
    copies: Math.round(clampNumber(raw?.copies, 1, 500, DEFAULT_SETTINGS.copies)),
    showGrid: raw?.showGrid === true,
    printGrid: raw?.printGrid === true,
    fitToCell: raw?.fitToCell !== false,
  }
}

function makePresetSettings(settings: LabelSheetSettings): LabelSheetPresetSettings {
  return {
    paperSize: settings.paperSize,
    customWidthMm: settings.customWidthMm,
    customHeightMm: settings.customHeightMm,
    rows: settings.rows,
    columns: settings.columns,
    marginTopMm: settings.marginTopMm,
    marginRightMm: settings.marginRightMm,
    marginBottomMm: settings.marginBottomMm,
    marginLeftMm: settings.marginLeftMm,
    gapHorizontalMm: settings.gapHorizontalMm,
    gapVerticalMm: settings.gapVerticalMm,
    printGrid: settings.printGrid,
    fitToCell: settings.fitToCell,
  }
}

function normalizePresetSettings(raw: Partial<LabelSheetPresetSettings> | null | undefined): LabelSheetPresetSettings {
  return makePresetSettings(normalizeSettings({
    ...raw,
    copies: DEFAULT_SETTINGS.copies,
    showGrid: DEFAULT_SETTINGS.showGrid,
    skipCells: DEFAULT_SETTINGS.skipCells,
  }))
}

const BUILT_IN_SHEET_PRESETS: LabelSheetPreset[] = [
  {
    id: 'builtin-a4-3x8',
    name: 'A4 3 x 8',
    builtin: true,
    settings: makePresetSettings(DEFAULT_SETTINGS),
  },
  {
    id: 'builtin-letter-3x10',
    name: 'Letter 3 x 10 (2.625 x 1 in)',
    builtin: true,
    settings: normalizePresetSettings({
      paperSize: 'letter',
      customWidthMm: 215.9,
      customHeightMm: 279.4,
      rows: 10,
      columns: 3,
      marginTopMm: 12.7,
      marginRightMm: 4.7625,
      marginBottomMm: 12.7,
      marginLeftMm: 4.7625,
      gapHorizontalMm: 3.175,
      gapVerticalMm: 0,
      printGrid: false,
      fitToCell: true,
    }),
  },
]

function readStoredSettings(): LabelSheetSettings {
  try {
    return normalizeSettings(JSON.parse(localStorage.getItem(LABEL_SHEET_SETTINGS_KEY) || 'null'))
  } catch {
    return normalizeSettings(null)
  }
}

function readStoredOutputMode(): LabelOutputMode {
  try {
    return localStorage.getItem(LABEL_OUTPUT_MODE_KEY) === 'sheet' ? 'sheet' : 'individual'
  } catch {
    return 'individual'
  }
}

function writeStoredSettings(settings: LabelSheetSettings) {
  try {
    localStorage.setItem(LABEL_SHEET_SETTINGS_KEY, JSON.stringify(settings))
  } catch {
    // Sheet preview/export still works when storage is blocked.
  }
}

function writeStoredOutputMode(mode: LabelOutputMode) {
  try {
    localStorage.setItem(LABEL_OUTPUT_MODE_KEY, mode)
  } catch {
    // Sheet preview/export still works when storage is blocked.
  }
}

function readStoredPresets(): LabelSheetPreset[] {
  try {
    const raw = JSON.parse(localStorage.getItem(LABEL_SHEET_PRESETS_KEY) || '[]')
    if (!Array.isArray(raw)) return []
    return raw
      .map((item): LabelSheetPreset | null => {
        if (!item || typeof item !== 'object') return null
        const name = typeof item.name === 'string' ? item.name.trim() : ''
        if (!name) return null
        return {
          id: typeof item.id === 'string' && item.id ? item.id : `custom-${Date.now().toString(36)}`,
          name,
          settings: normalizePresetSettings(item.settings),
        }
      })
      .filter((item): item is LabelSheetPreset => item !== null)
  } catch {
    return []
  }
}

function writeStoredPresets(presets: LabelSheetPreset[]) {
  try {
    localStorage.setItem(LABEL_SHEET_PRESETS_KEY, JSON.stringify(presets.map(preset => ({
      id: preset.id,
      name: preset.name,
      settings: preset.settings,
    }))))
  } catch {
    // Sheet printing still works when storage is blocked.
  }
}

function getInput(id: string): HTMLInputElement | null {
  return document.getElementById(id) as HTMLInputElement | null
}

function getButton(id: string): HTMLButtonElement | null {
  return document.getElementById(id) as HTMLButtonElement | null
}

function getSelect(id: string): HTMLSelectElement | null {
  return document.getElementById(id) as HTMLSelectElement | null
}

function setNumberInput(id: string, value: number) {
  const input = getInput(id)
  if (input) input.value = String(value)
}

function readNumberInput(id: string, fallback: number) {
  return Number(getInput(id)?.value ?? fallback)
}

function getFirstUsableSlot(settings: LabelSheetSettings, layout = getLabelSheetLayout(settings)) {
  return Math.min(settings.skipCells, layout.cellsPerPage - 1)
}

function getLabelSheetJobSize(labelCount: number, settings: LabelSheetSettings) {
  const layout = getLabelSheetLayout(settings)
  const labelInstances = labelCount * settings.copies
  const firstUsableSlot = getFirstUsableSlot(settings, layout)
  return {
    labelInstances,
    pageCount: Math.max(1, Math.ceil((labelInstances + firstUsableSlot) / layout.cellsPerPage)),
  }
}

function confirmLargeLabelSheetJob(labelCount: number, settings: LabelSheetSettings) {
  const job = getLabelSheetJobSize(labelCount, settings)
  if (job.labelInstances <= LARGE_JOB_LABEL_LIMIT && job.pageCount <= LARGE_JOB_PAGE_LIMIT) return true

  const signature = `${labelCount}:${settings.copies}:${settings.rows}:${settings.columns}:${settings.skipCells}`
  if (confirmedLargeJobs.has(signature)) return true
  const ok = window.confirm(`This label-paper job will render ${job.labelInstances} labels across ${job.pageCount} pages and may be slow or create a large PDF. Continue?`)
  if (ok) confirmedLargeJobs.add(signature)
  return ok
}

function applySheetCapacityLimits(settings: LabelSheetSettings) {
  const layout = getLabelSheetLayout(settings)
  settings.skipCells = getFirstUsableSlot(settings, layout)
  const skipCells = getInput('sheet-skip-cells')
  if (skipCells) {
    skipCells.max = String(Math.max(0, layout.cellsPerPage - 1))
    skipCells.value = String(settings.skipCells)
  }
  return settings
}

function applyPresetSettings(current: LabelSheetSettings, preset: LabelSheetPresetSettings) {
  return applySheetCapacityLimits(normalizeSettings({
    ...current,
    ...preset,
  }))
}

function formatMm(value: number) {
  const rounded = Math.round(value * 10) / 10
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)
}

function makePresetId() {
  return `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

export function bindLabelSheetControls(
  onChange: () => void,
  getTranslation: (key: string, fallback: string) => string = (_key, fallback) => fallback,
): LabelSheetControls {
  const outputMode = getSelect('output-mode')
  const panel = document.getElementById('label-sheet-settings') as HTMLElement | null
  const presetSelect = getSelect('sheet-preset')
  const presetName = getInput('sheet-preset-name')
  const loadPreset = getButton('sheet-load-preset')
  const savePreset = getButton('sheet-save-preset')
  const deletePreset = getButton('sheet-delete-preset')
  const layoutSummary = document.getElementById('sheet-layout-summary-value') as HTMLElement | null
  const paperSize = getSelect('sheet-paper-size')
  const customSize = document.getElementById('sheet-custom-size') as HTMLElement | null
  const settings = readStoredSettings()
  const storedOutputMode = readStoredOutputMode()
  let customPresets = readStoredPresets()
  let selectedPresetId = CUSTOM_PRESET_ID

  const findPreset = (id: string) => [...BUILT_IN_SHEET_PRESETS, ...customPresets].find(preset => preset.id === id)

  const syncPresetControls = () => {
    const preset = findPreset(selectedPresetId)
    if (presetName) presetName.value = preset?.name ?? ''
    if (loadPreset) loadPreset.disabled = !preset
    if (deletePreset) deletePreset.disabled = !preset || preset.builtin === true
  }

  const renderPresetOptions = () => {
    if (!presetSelect) return
    const previousValue = selectedPresetId
    presetSelect.replaceChildren()

    const customOption = new Option(getTranslation('labelPrint.currentPaperSetup', 'Current setup'), CUSTOM_PRESET_ID)
    presetSelect.appendChild(customOption)

    const builtInGroup = document.createElement('optgroup')
    builtInGroup.label = getTranslation('labelPrint.builtInPaperPresets', 'Built-in presets')
    BUILT_IN_SHEET_PRESETS.forEach(preset => builtInGroup.appendChild(new Option(preset.name, preset.id)))
    presetSelect.appendChild(builtInGroup)

    if (customPresets.length > 0) {
      const savedGroup = document.createElement('optgroup')
      savedGroup.label = getTranslation('labelPrint.savedPaperPresets', 'Saved presets')
      customPresets.forEach(preset => savedGroup.appendChild(new Option(preset.name, preset.id)))
      presetSelect.appendChild(savedGroup)
    }

    selectedPresetId = findPreset(previousValue) ? previousValue : CUSTOM_PRESET_ID
    presetSelect.value = selectedPresetId
    syncPresetControls()
  }

  const updateLayoutSummary = (next: LabelSheetSettings) => {
    const layout = getLabelSheetLayout(next)
    const horizontalPitch = layout.cellWidthMm + next.gapHorizontalMm
    const verticalPitch = layout.cellHeightMm + next.gapVerticalMm
    if (!layoutSummary) return
    layoutSummary.textContent = getTranslation(
      'labelPrint.paperLayoutSummary',
      `Cell ${formatMm(layout.cellWidthMm)} x ${formatMm(layout.cellHeightMm)} mm · Pitch ${formatMm(horizontalPitch)} x ${formatMm(verticalPitch)} mm`,
    )
      .replace('{width}', formatMm(layout.cellWidthMm))
      .replace('{height}', formatMm(layout.cellHeightMm))
      .replace('{horizontalPitch}', formatMm(horizontalPitch))
      .replace('{verticalPitch}', formatMm(verticalPitch))
  }

  const setFormValues = (next: LabelSheetSettings) => {
    if (paperSize) paperSize.value = next.paperSize
    setNumberInput('sheet-custom-width', next.customWidthMm)
    setNumberInput('sheet-custom-height', next.customHeightMm)
    setNumberInput('sheet-rows', next.rows)
    setNumberInput('sheet-columns', next.columns)
    setNumberInput('sheet-margin-top', next.marginTopMm)
    setNumberInput('sheet-margin-right', next.marginRightMm)
    setNumberInput('sheet-margin-bottom', next.marginBottomMm)
    setNumberInput('sheet-margin-left', next.marginLeftMm)
    setNumberInput('sheet-gap-horizontal', next.gapHorizontalMm)
    setNumberInput('sheet-gap-vertical', next.gapVerticalMm)
    setNumberInput('sheet-skip-cells', next.skipCells)
    setNumberInput('sheet-copies', next.copies)
    const showGrid = getInput('sheet-show-grid')
    const printGrid = getInput('sheet-print-grid')
    const fitToCell = getInput('sheet-fit-to-cell')
    if (showGrid) showGrid.checked = next.showGrid
    if (printGrid) printGrid.checked = next.printGrid
    if (fitToCell) fitToCell.checked = next.fitToCell
    updateLayoutSummary(next)
  }

  const readFormSettings = () => applySheetCapacityLimits(normalizeSettings({
    paperSize: paperSize?.value as LabelSheetSettings['paperSize'],
    customWidthMm: readNumberInput('sheet-custom-width', settings.customWidthMm),
    customHeightMm: readNumberInput('sheet-custom-height', settings.customHeightMm),
    rows: readNumberInput('sheet-rows', settings.rows),
    columns: readNumberInput('sheet-columns', settings.columns),
    marginTopMm: readNumberInput('sheet-margin-top', settings.marginTopMm),
    marginRightMm: readNumberInput('sheet-margin-right', settings.marginRightMm),
    marginBottomMm: readNumberInput('sheet-margin-bottom', settings.marginBottomMm),
    marginLeftMm: readNumberInput('sheet-margin-left', settings.marginLeftMm),
    gapHorizontalMm: readNumberInput('sheet-gap-horizontal', settings.gapHorizontalMm),
    gapVerticalMm: readNumberInput('sheet-gap-vertical', settings.gapVerticalMm),
    skipCells: readNumberInput('sheet-skip-cells', settings.skipCells),
    copies: readNumberInput('sheet-copies', settings.copies),
    showGrid: getInput('sheet-show-grid')?.checked,
    printGrid: getInput('sheet-print-grid')?.checked,
    fitToCell: getInput('sheet-fit-to-cell')?.checked,
  }))

  const syncVisibility = () => {
    const isSheet = outputMode?.value === 'sheet'
    if (panel) panel.style.display = isSheet ? '' : 'none'
    if (customSize) customSize.style.display = paperSize?.value === 'custom' ? '' : 'none'
  }

  if (outputMode) outputMode.value = storedOutputMode
  setFormValues(applySheetCapacityLimits(settings))
  renderPresetOptions()
  syncVisibility()

  const handleChange = () => {
    const next = readFormSettings()
    selectedPresetId = CUSTOM_PRESET_ID
    setFormValues(next)
    renderPresetOptions()
    writeStoredSettings(next)
    syncVisibility()
    onChange()
  }

  presetSelect?.addEventListener('change', () => {
    selectedPresetId = presetSelect.value
    syncPresetControls()
  })

  loadPreset?.addEventListener('click', () => {
    const preset = findPreset(selectedPresetId)
    if (!preset) return
    const next = applyPresetSettings(readFormSettings(), preset.settings)
    setFormValues(next)
    writeStoredSettings(next)
    syncVisibility()
    syncPresetControls()
    onChange()
  })

  savePreset?.addEventListener('click', () => {
    const selectedPreset = findPreset(selectedPresetId)
    const selectedCustomPreset = selectedPreset && !selectedPreset.builtin
      ? customPresets.find(preset => preset.id === selectedPreset.id)
      : null
    const fallbackName = selectedCustomPreset?.name || getTranslation('labelPrint.defaultPaperPresetName', 'Custom label paper')
    const name = (presetName?.value || fallbackName).trim() || fallbackName
    const existingByName = customPresets.find(preset => preset.name === name)
    const existingCustom = selectedCustomPreset || existingByName
    const preset: LabelSheetPreset = {
      id: existingCustom?.id || makePresetId(),
      name,
      settings: makePresetSettings(readFormSettings()),
    }

    customPresets = existingCustom
      ? customPresets.map(item => item.id === preset.id ? preset : item)
      : [...customPresets, preset]
    selectedPresetId = preset.id
    writeStoredPresets(customPresets)
    renderPresetOptions()
  })

  deletePreset?.addEventListener('click', () => {
    const preset = findPreset(selectedPresetId)
    if (!preset || preset.builtin) return
    customPresets = customPresets.filter(item => item.id !== preset.id)
    selectedPresetId = CUSTOM_PRESET_ID
    writeStoredPresets(customPresets)
    renderPresetOptions()
  })

  outputMode?.addEventListener('change', () => {
    writeStoredOutputMode(outputMode.value === 'sheet' ? 'sheet' : 'individual')
    syncVisibility()
    onChange()
  })
  document.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-label-sheet-control]').forEach(control => {
    control.addEventListener('change', handleChange)
    if (control instanceof HTMLInputElement && (control.type === 'number' || control.type === 'range')) {
      control.addEventListener('input', handleChange)
    }
  })

  return {
    getOutputMode: () => outputMode?.value === 'sheet' ? 'sheet' : 'individual',
    getSettings: readFormSettings,
    setOutputMode: (mode) => {
      if (outputMode) outputMode.value = mode
      writeStoredOutputMode(mode)
      syncVisibility()
      onChange()
    },
  }
}

export function getLabelSheetLayout(settings: LabelSheetSettings): LabelSheetLayout {
  const preset = settings.paperSize === 'custom' ? null : PAPER_SIZES[settings.paperSize]
  const paperWidthMm = preset?.widthMm ?? settings.customWidthMm
  const paperHeightMm = preset?.heightMm ?? settings.customHeightMm
  const printableWidth = Math.max(1, paperWidthMm - settings.marginLeftMm - settings.marginRightMm - settings.gapHorizontalMm * (settings.columns - 1))
  const printableHeight = Math.max(1, paperHeightMm - settings.marginTopMm - settings.marginBottomMm - settings.gapVerticalMm * (settings.rows - 1))
  return {
    paperWidthMm,
    paperHeightMm,
    cellWidthMm: printableWidth / settings.columns,
    cellHeightMm: printableHeight / settings.rows,
    cellsPerPage: settings.rows * settings.columns,
  }
}

function expandedIndexes(count: number, settings: LabelSheetSettings) {
  const indexes: number[] = []
  for (let copy = 0; copy < settings.copies; copy += 1) {
    for (let index = 0; index < count; index += 1) {
      indexes.push(index)
    }
  }
  return indexes
}

function removeElementIds(element: Element) {
  element.removeAttribute('id')
  element.querySelectorAll('[id]').forEach(child => child.removeAttribute('id'))
}

function getSourceLabel(source: HTMLElement): HTMLElement | null {
  if (source.classList.contains('label-preview')) return source
  return source.querySelector<HTMLElement>('.label-preview')
}

function ensureSourceBin(previewRoot: HTMLElement) {
  let bin = previewRoot.querySelector<HTMLElement>(`:scope > .${SOURCE_BIN_CLASS}`)
  if (!bin) {
    bin = document.createElement('div')
    bin.className = SOURCE_BIN_CLASS
    previewRoot.appendChild(bin)
  }
  return bin
}

function getPreviewToolbar(previewRoot: HTMLElement) {
  const toolbar = previewRoot.querySelector('.preview-zoom-bar')
  return toolbar instanceof HTMLElement ? toolbar : null
}

function syncFixedPreviewToolbar(previewRoot: HTMLElement) {
  const toolbar = getPreviewToolbar(previewRoot)
  if (!toolbar) return
  if (!previewRoot.classList.contains(SHEET_MODE_CLASS)) return
  const rect = previewRoot.getBoundingClientRect()
  toolbar.style.position = 'fixed'
  toolbar.style.top = `${rect.top}px`
  toolbar.style.left = `${rect.left + rect.width / 2}px`
  toolbar.style.transform = 'translateX(-50%)'
}

function bindFixedPreviewToolbar(previewRoot: HTMLElement) {
  syncFixedPreviewToolbar(previewRoot)
  if (fixedToolbarPreviewRoots.has(previewRoot)) return
  fixedToolbarPreviewRoots.add(previewRoot)
  previewRoot.addEventListener('scroll', () => syncFixedPreviewToolbar(previewRoot), { passive: true })
  window.addEventListener('resize', () => syncFixedPreviewToolbar(previewRoot), { passive: true })
}

function restorePreviewToolbar(previewRoot: HTMLElement) {
  const toolbar = getPreviewToolbar(previewRoot)
  if (!toolbar) return
  toolbar.style.removeProperty('position')
  toolbar.style.removeProperty('top')
  toolbar.style.removeProperty('left')
  toolbar.style.removeProperty('transform')
}

export function restoreIndividualLabelPreview(previewRoot: HTMLElement, sourceElements: HTMLElement[]) {
  previewRoot.classList.remove(SHEET_MODE_CLASS)
  restorePreviewToolbar(previewRoot)
  previewRoot.querySelectorAll(`.${SHEET_PAGE_FRAME_CLASS}`).forEach(frame => frame.remove())
  previewRoot.querySelectorAll('.label-sheet-page').forEach(page => page.remove())
  sourceElements.forEach(source => {
    const position = originalPositions.get(source)
    if (!position) return
    const nextSibling = position.nextSibling?.parentNode === position.parent ? position.nextSibling : null
    position.parent.insertBefore(source, nextSibling)
  })
  previewRoot.querySelector<HTMLElement>(`:scope > .${SOURCE_BIN_CLASS}`)?.remove()
  clearLabelSheetPrintStyle()
}

export function renderLabelSheetPreview(options: LabelSheetPreviewOptions) {
  const { previewRoot, sourceElements, settings, labelWidthMm, labelHeightMm } = options
  if (!confirmLargeLabelSheetJob(sourceElements.length, settings)) {
    restoreIndividualLabelPreview(previewRoot, sourceElements)
    return
  }
  previewRoot.classList.add(SHEET_MODE_CLASS)
  const layout = getLabelSheetLayout(settings)
  const sourceBin = ensureSourceBin(previewRoot)
  bindFixedPreviewToolbar(previewRoot)
  previewRoot.querySelectorAll(`.${SHEET_PAGE_FRAME_CLASS}`).forEach(frame => frame.remove())
  previewRoot.querySelectorAll('.label-sheet-page').forEach(page => page.remove())

  sourceElements.forEach(source => {
    if (!originalPositions.has(source) && source.parentNode) {
      originalPositions.set(source, { parent: source.parentNode, nextSibling: source.nextSibling })
    }
    sourceBin.appendChild(source)
  })

  const indexes = expandedIndexes(sourceElements.length, settings)
  let page: HTMLElement | null = null
  let grid: HTMLElement | null = null
  const firstUsableSlot = getFirstUsableSlot(settings, layout)

  indexes.forEach((sourceIndex, itemIndex) => {
    const absoluteSlot = itemIndex + firstUsableSlot
    const pageIndex = Math.floor(absoluteSlot / layout.cellsPerPage)
    const cellIndex = absoluteSlot % layout.cellsPerPage
    if (!page || Number(page.dataset.pageIndex) !== pageIndex) {
      const pageFrame = document.createElement('div')
      pageFrame.className = SHEET_PAGE_FRAME_CLASS
      pageFrame.dataset.pageIndex = String(pageIndex)
      page = document.createElement('section')
      page.className = `label-sheet-page${settings.printGrid ? ' label-sheet-print-grid' : ''}`
      page.dataset.pageIndex = String(pageIndex)
      page.style.width = `${layout.paperWidthMm}mm`
      page.style.height = `${layout.paperHeightMm}mm`
      page.style.padding = `${settings.marginTopMm}mm ${settings.marginRightMm}mm ${settings.marginBottomMm}mm ${settings.marginLeftMm}mm`
      grid = document.createElement('div')
      grid.className = 'label-sheet-grid'
      grid.style.gridTemplateColumns = `repeat(${settings.columns}, ${layout.cellWidthMm}mm)`
      grid.style.gridTemplateRows = `repeat(${settings.rows}, ${layout.cellHeightMm}mm)`
      grid.style.gap = `${settings.gapVerticalMm}mm ${settings.gapHorizontalMm}mm`
      page.appendChild(grid)
      pageFrame.appendChild(page)
      previewRoot.appendChild(pageFrame)
      for (let i = 0; i < layout.cellsPerPage; i += 1) {
        const emptyCell = document.createElement('div')
        emptyCell.className = `label-sheet-cell label-sheet-cell-empty${settings.showGrid || settings.printGrid ? ' label-sheet-cell-grid' : ''}`
        grid.appendChild(emptyCell)
      }
    }

    const cell = grid?.children[cellIndex] as HTMLElement | undefined
    if (!cell) return
    cell.className = `label-sheet-cell${settings.showGrid || settings.printGrid ? ' label-sheet-cell-grid' : ''}`
    cell.replaceChildren()
    const shell = document.createElement('div')
    shell.className = 'label-sheet-label-shell'
    const scale = settings.fitToCell ? Math.min(1, layout.cellWidthMm / labelWidthMm, layout.cellHeightMm / labelHeightMm) : 1
    shell.style.width = `${labelWidthMm * scale}mm`
    shell.style.height = `${labelHeightMm * scale}mm`

    const content = document.createElement('div')
    content.className = 'label-sheet-label-content'
    content.style.width = `${labelWidthMm}mm`
    content.style.height = `${labelHeightMm}mm`
    content.style.transform = `scale(${scale})`

    const source = sourceElements[sourceIndex]
    const sourceLabel = getSourceLabel(source)
    if (sourceLabel) {
      const clone = sourceLabel.cloneNode(true) as HTMLElement
      removeElementIds(clone)
      clone.style.zoom = '1'
      clone.style.transform = 'none'
      clone.style.transformOrigin = 'unset'
      content.appendChild(clone)
    }
    shell.appendChild(content)
    cell.appendChild(shell)
  })

  updateLabelSheetPrintStyle(settings)
}

export function syncLabelSheetPreview(options: SyncLabelSheetPreviewOptions) {
  const { controls, previewRoot, sourceElements, labelDimensions } = options
  if (controls.getOutputMode() !== 'sheet') {
    restoreIndividualLabelPreview(previewRoot, sourceElements)
    return
  }
  if (sourceElements.length === 0) return
  renderLabelSheetPreview({
    previewRoot,
    sourceElements,
    settings: controls.getSettings(),
    labelWidthMm: labelDimensions.widthMm,
    labelHeightMm: labelDimensions.heightMm,
  })
}

export function applyLabelSheetPreviewZoom(previewRoot: HTMLElement, zoomPercent: number) {
  const zoom = Math.min(3, Math.max(0.25, (Number(zoomPercent) || 100) / 100))
  previewRoot.querySelectorAll<HTMLElement>('.label-sheet-page').forEach(page => {
    const frame = page.parentElement?.classList.contains(SHEET_PAGE_FRAME_CLASS)
      ? page.parentElement as HTMLElement
      : null
    page.style.zoom = '1'
    page.style.position = 'absolute'
    page.style.left = '0'
    page.style.top = '0'
    page.style.transform = `scale(${zoom})`
    page.style.transformOrigin = 'top left'
    if (frame) {
      frame.style.width = `${page.offsetWidth * zoom}px`
      frame.style.height = `${page.offsetHeight * zoom}px`
    }
  })
}

export function syncLabelSheetPngExportState(
  controls: LabelSheetControls,
  button: HTMLButtonElement,
  getTranslation: (key: string, fallback: string) => string,
) {
  const isSheetMode = controls.getOutputMode() === 'sheet'
  const unavailableText = getTranslation('labelPrint.pngUnavailableInSheetMode', 'PNG export not available in label paper mode')

  if (!('labelSheetOriginalTitle' in button.dataset)) {
    button.dataset.labelSheetOriginalTitle = button.getAttribute('title') ?? ''
  }

  button.disabled = isSheetMode
  button.classList.toggle('is-disabled', isSheetMode)

  if (isSheetMode) {
    button.setAttribute('aria-disabled', 'true')
    button.setAttribute('title', unavailableText)
  } else {
    button.removeAttribute('aria-disabled')
    const originalTitle = button.dataset.labelSheetOriginalTitle || ''
    if (originalTitle) button.setAttribute('title', originalTitle)
    else button.removeAttribute('title')
  }
}

export function updateLabelSheetPrintStyle(settings: LabelSheetSettings, styleId = PAGE_STYLE_ID) {
  const layout = getLabelSheetLayout(settings)
  const pageSize = settings.paperSize === 'letter'
    ? 'letter'
    : settings.paperSize === 'a4'
      ? 'A4'
      : `${layout.paperWidthMm}mm ${layout.paperHeightMm}mm`
  let styleEl = document.getElementById(styleId)
  if (!styleEl) {
    styleEl = document.createElement('style')
    styleEl.id = styleId
    document.head.appendChild(styleEl)
  }

  styleEl.innerHTML = `
    @page { size: ${pageSize}; margin: 0; }
    .label-sheet-page {
      box-sizing: border-box;
      background: white;
      outline: 0.3mm dashed rgba(0,0,0,0.28);
      outline-offset: 1.5mm;
      color: black;
      display: block;
      flex: 0 0 auto;
      overflow: hidden;
    }
    .${SHEET_PAGE_FRAME_CLASS} {
      flex: 0 0 auto;
      margin-inline: auto;
      position: relative;
    }
    .label-sheet-grid {
      display: grid;
      width: 100%;
      height: 100%;
      box-sizing: border-box;
    }
    .label-sheet-cell {
      align-items: center;
      box-sizing: border-box;
      display: flex;
      justify-content: center;
      overflow: hidden;
    }
    .label-sheet-cell-grid {
      border: 0.2mm solid #c8c8c8;
    }
    .label-sheet-label-shell {
      flex: 0 0 auto;
      position: relative;
    }
    .label-sheet-label-shell::after {
      border: 0.3mm dashed rgba(0,0,0,0.28);
      box-sizing: border-box;
      content: '';
      inset: 0.45mm;
      pointer-events: none;
      position: absolute;
    }
    .label-sheet-label-content {
      transform-origin: top left;
    }
    .label-sheet-page .label-preview {
      box-shadow: none !important;
    }
    .${SOURCE_BIN_CLASS} {
      left: -10000px;
      pointer-events: none;
      position: fixed;
      top: 0;
      z-index: -1;
    }
    @media print {
      html,
      body {
        box-sizing: border-box !important;
        margin: 0 !important;
        max-width: ${layout.paperWidthMm}mm !important;
        min-width: 0 !important;
        overflow-x: hidden !important;
        padding: 0 !important;
        width: ${layout.paperWidthMm}mm !important;
      }
      .fm-page,
      .fm-page > main,
      .print-page,
      .preview-container,
      .preview-scroll-area {
        box-sizing: border-box !important;
        display: block !important;
        margin: 0 !important;
        max-width: ${layout.paperWidthMm}mm !important;
        min-width: 0 !important;
        overflow: visible !important;
        padding: 0 !important;
        width: ${layout.paperWidthMm}mm !important;
      }
      .label-sheet-page {
        break-after: auto !important;
        break-before: auto !important;
        break-inside: auto !important;
        outline: none !important;
        height: ${layout.paperHeightMm}mm !important;
        margin: 0 !important;
        max-height: ${layout.paperHeightMm}mm !important;
        max-width: ${layout.paperWidthMm}mm !important;
        min-height: ${layout.paperHeightMm}mm !important;
        min-width: ${layout.paperWidthMm}mm !important;
        padding: ${settings.marginTopMm}mm ${settings.marginRightMm}mm ${settings.marginBottomMm}mm ${settings.marginLeftMm}mm !important;
        page-break-after: auto !important;
        page-break-before: auto !important;
        page-break-inside: auto !important;
        position: static !important;
        transform: none !important;
        width: ${layout.paperWidthMm}mm !important;
        zoom: 1 !important;
      }
      .${SHEET_PAGE_FRAME_CLASS} {
        display: contents !important;
        height: auto !important;
        width: auto !important;
      }
      .label-sheet-page:not(.label-sheet-print-grid) .label-sheet-cell-grid {
        border: 0 !important;
      }
      .${SHEET_PAGE_FRAME_CLASS} + .${SHEET_PAGE_FRAME_CLASS} .label-sheet-page {
        break-before: page !important;
        page-break-before: always !important;
      }
      .label-sheet-page .label-preview {
        box-shadow: none !important;
        outline: none !important;
        transform: none !important;
        zoom: 1 !important;
      }
      .label-sheet-label-shell::after {
        display: none !important;
      }
      .${SOURCE_BIN_CLASS} {
        display: none !important;
      }
    }
  `
}

export function clearLabelSheetPrintStyle(styleId = PAGE_STYLE_ID) {
  document.getElementById(styleId)?.remove()
}

export async function saveLabelSheetPagesAsPdf(labels: LabelPdfPage[], filename: string, settings: LabelSheetSettings) {
  if (labels.length === 0) return
  if (!confirmLargeLabelSheetJob(labels.length, settings)) return

  const { jsPDF } = await import('jspdf')
  const layout = getLabelSheetLayout(settings)
  const pdf = new jsPDF({
    orientation: layout.paperWidthMm > layout.paperHeightMm ? 'l' : 'p',
    unit: 'mm',
    format: [layout.paperWidthMm, layout.paperHeightMm],
  })
  const indexes = expandedIndexes(labels.length, settings)
  const firstUsableSlot = getFirstUsableSlot(settings, layout)
  const pageCount = Math.max(1, Math.ceil((indexes.length + firstUsableSlot) / layout.cellsPerPage))

  const drawGrid = (pageIndex: number) => {
    if (!settings.printGrid) return
    pdf.setPage(pageIndex + 1)
    pdf.setDrawColor(200, 200, 200)
    pdf.setLineWidth(0.2)
    for (let cellIndex = 0; cellIndex < layout.cellsPerPage; cellIndex += 1) {
      const row = Math.floor(cellIndex / settings.columns)
      const column = cellIndex % settings.columns
      const cellX = settings.marginLeftMm + column * (layout.cellWidthMm + settings.gapHorizontalMm)
      const cellY = settings.marginTopMm + row * (layout.cellHeightMm + settings.gapVerticalMm)
      pdf.rect(cellX, cellY, layout.cellWidthMm, layout.cellHeightMm)
    }
  }

  for (let pageIndex = 1; pageIndex < pageCount; pageIndex += 1) {
    pdf.addPage([layout.paperWidthMm, layout.paperHeightMm], layout.paperWidthMm > layout.paperHeightMm ? 'l' : 'p')
  }
  for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
    drawGrid(pageIndex)
  }

  indexes.forEach((labelIndex, itemIndex) => {
    const absoluteSlot = itemIndex + firstUsableSlot
    const pageIndex = Math.floor(absoluteSlot / layout.cellsPerPage)
    const cellIndex = absoluteSlot % layout.cellsPerPage
    pdf.setPage(pageIndex + 1)

    const row = Math.floor(cellIndex / settings.columns)
    const column = cellIndex % settings.columns
    const cellX = settings.marginLeftMm + column * (layout.cellWidthMm + settings.gapHorizontalMm)
    const cellY = settings.marginTopMm + row * (layout.cellHeightMm + settings.gapVerticalMm)
    const label = labels[labelIndex]
    const scale = settings.fitToCell ? Math.min(1, layout.cellWidthMm / label.widthMm, layout.cellHeightMm / label.heightMm) : 1
    const width = label.widthMm * scale
    const height = label.heightMm * scale
    const x = cellX + (layout.cellWidthMm - width) / 2
    const y = cellY + (layout.cellHeightMm - height) / 2

    pdf.saveGraphicsState()
    pdf.rect(cellX, cellY, layout.cellWidthMm, layout.cellHeightMm, null)
    pdf.clip()
    pdf.addImage(label.dataUrl, 'PNG', x, y, width, height, `label-sheet-source-${labelIndex}`, 'FAST')
    pdf.restoreGraphicsState()
  })

  pdf.save(filename)
}
